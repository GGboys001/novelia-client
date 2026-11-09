use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use axum::{
    body::Body,
    extract::State,
    http::{
        header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode,
    },
    routing::any,
    Router,
};
use reqwest::{Client, Url};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
struct CookieJar {
    store: Arc<Mutex<cookie_store::CookieStore>>,
    path: PathBuf,
}

impl CookieJar {
    fn new(path: PathBuf) -> Self {
        let store = if let Ok(file) = std::fs::File::open(&path) {
            cookie_store::serde::json::load_all(std::io::BufReader::new(file))
                .unwrap_or_else(|_| cookie_store::CookieStore::new())
        } else {
            cookie_store::CookieStore::new()
        };
        Self {
            store: Arc::new(Mutex::new(store)),
            path,
        }
    }

    fn persist(&self, store: &cookie_store::CookieStore) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::File::create(&self.path) {
            let _ = cookie_store::serde::json::save_incl_expired_and_nonpersistent(store, &mut file);
        }
    }

    fn cookie_header(&self, url: &Url) -> Option<HeaderValue> {
        let store = self.store.lock().ok()?;
        let mut value = String::new();
        for (name, cookie) in store.get_request_values(url) {
            if !value.is_empty() {
                value.push_str("; ");
            }
            value.push_str(name);
            value.push('=');
            value.push_str(cookie);
        }
        if value.is_empty() {
            None
        } else {
            HeaderValue::from_str(&value).ok()
        }
    }

    fn store_response_cookies(&self, values: &[HeaderValue], url: &Url) {
        let Ok(mut store) = self.store.lock() else {
            return;
        };
        for header in values {
            let Ok(value) = header.to_str() else {
                continue;
            };
            let Ok(cookie) = cookie_store::RawCookie::parse(value.to_owned()) else {
                continue;
            };
            let _ = store.insert_raw(&cookie, url);
        }
        self.persist(&store);
    }
}

impl reqwest::cookie::CookieStore for CookieJar {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &HeaderValue>,
        url: &Url,
    ) {
        let values: Vec<HeaderValue> = cookie_headers.cloned().collect();
        self.store_response_cookies(&values, url);
    }

    fn cookies(&self, url: &Url) -> Option<HeaderValue> {
        self.cookie_header(url)
    }
}

fn configured_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(normalize_proxy(value.trim().to_owned()));
            }
        }
    }

    #[cfg(windows)]
    {
        windows_system_proxy().map(normalize_proxy)
    }

    #[cfg(not(windows))]
    {
        None
    }
}

fn normalize_proxy(proxy: String) -> String {
    if proxy.contains("://") {
        proxy
    } else {
        format!("http://{proxy}")
    }
}

#[cfg(windows)]
fn windows_system_proxy() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(
            "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
            KEY_READ,
        )
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }

    let candidate = if server.contains('=') {
        server
            .split(';')
            .find_map(|part| {
                let part = part.trim();
                part.strip_prefix("https=")
                    .or_else(|| part.strip_prefix("http="))
            })?
            .to_owned()
    } else {
        server.to_owned()
    };

    (!candidate.is_empty()).then_some(candidate)
}

const NOVELIA_ORIGIN: &str = "https://n.novelia.cc";
const NOVELIA_REFERER: &str = "https://n.novelia.cc/";
const NOVELIA_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
    (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const MAX_BODY_SIZE: usize = 200 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct NetworkConfig {
    /// system | direct | manual
    mode: String,
    /// 手动代理地址，例如 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080
    proxy: String,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            // Android 使用进程内 Go ECH 桥接，桌面端使用 ECH 侧车。
            mode: "ech".to_owned(),
            proxy: String::new(),
        }
    }
}

struct EchSidecar {
    #[allow(dead_code)]
    child: Child,
    #[allow(dead_code)]
    stdin: Option<ChildStdin>,
    port: u16,
    token: String,
}

#[derive(Clone)]
struct AppState {
    client: Arc<RwLock<Client>>,
    /// 访问本地侧车用，不走任何上游代理。
    local_client: Client,
    jar: CookieJar,
    config: Arc<RwLock<NetworkConfig>>,
    config_path: PathBuf,
    ech: Arc<Mutex<Option<EchSidecar>>>,
    api_base: String,
    auth_base: String,
    forum_base: String,
}

fn ech_binary_path() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = [
        exe_dir.join("ech-proxy.exe"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("ech-proxy.exe"),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn start_ech_sidecar() -> Result<EchSidecar, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    let binary = ech_binary_path().ok_or_else(|| "未找到 ECH 侧车 ech-proxy.exe".to_owned())?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let token = format!("{nanos:x}{:x}", std::process::id());

    let mut command = Command::new(&binary);
    command
        .arg("--token")
        .arg(&token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 ECH 侧车失败: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ECH 侧车没有标准输出".to_owned())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("读取 ECH 侧车端口失败: {error}"))?;
    let port = line
        .trim()
        .strip_prefix("PORT=")
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("ECH 侧车未返回端口: {line}"))?;

    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!("ECH 侧车已退出: {status}"));
    }

    let stdin = child.stdin.take();

    Ok(EchSidecar {
        child,
        stdin,
        port,
        token,
    })
}

fn ech_endpoint(state: &AppState) -> Result<(u16, String), String> {
    #[cfg(target_os = "android")]
    {
        // Android 端由 Kotlin 启动进程内 Go ECH 桥接，端口和令牌与 mobile 包常量一致。
        let _ = state;
        Ok((43111, "novelia-ech-bridge-v1".to_owned()))
    }

    #[cfg(not(target_os = "android"))]
    {
        let guard = state
            .ech
            .lock()
            .map_err(|_| "ECH 侧车状态不可用".to_owned())?;
        match guard.as_ref() {
            Some(sidecar) => Ok((sidecar.port, sidecar.token.clone())),
            None => Err("ECH 侧车未启动".to_owned()),
        }
    }
}

fn build_client(jar: CookieJar, config: &NetworkConfig) -> Result<Client, String> {
    let mut builder = Client::builder()
        .cookie_provider(Arc::new(jar))
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Some(Duration::from_secs(30)));

    let proxy_url = match config.mode.as_str() {
        "direct" | "ech" => None,
        "manual" => {
            let value = config.proxy.trim();
            if value.is_empty() {
                return Err("请填写代理地址".to_owned());
            }
            Some(normalize_proxy(value.to_owned()))
        }
        _ => configured_proxy(),
    };

    if let Some(proxy_url) = proxy_url {
        let proxy = reqwest::Proxy::all(&proxy_url).map_err(|error| format!("代理地址无效: {error}"))?;
        builder = builder.proxy(proxy);
    }

    builder.build().map_err(|error| error.to_string())
}

fn save_network_config(path: &PathBuf, config: &NetworkConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败: {error}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("保存网络设置失败: {error}"))
}

fn validate_network_config(config: &NetworkConfig) -> Result<(), String> {
    match config.mode.as_str() {
        "system" | "direct" | "ech" => Ok(()),
        "manual" => {
            if config.proxy.trim().is_empty() {
                Err("请填写代理地址".to_owned())
            } else {
                Ok(())
            }
        }
        other => Err(format!("未知的网络模式: {other}")),
    }
}

#[tauri::command]
fn get_network_config(state: tauri::State<'_, AppState>) -> NetworkConfig {
    state
        .config
        .read()
        .map(|config| config.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn set_network_config(
    state: tauri::State<'_, AppState>,
    config: NetworkConfig,
) -> Result<NetworkConfig, String> {
    validate_network_config(&config)?;

    if config.mode == "ech" && ech_endpoint(&state).is_err() {
        let sidecar = start_ech_sidecar()?;
        *state
            .ech
            .lock()
            .map_err(|_| "ECH 侧车状态不可用".to_owned())? = Some(sidecar);
    }

    let client = build_client(state.jar.clone(), &config)?;
    save_network_config(&state.config_path, &config)?;

    if let Ok(mut current) = state.config.write() {
        *current = config.clone();
    }
    if let Ok(mut current) = state.client.write() {
        *current = client;
    }

    Ok(config)
}

#[tauri::command]
async fn test_network(
    state: tauri::State<'_, AppState>,
    config: NetworkConfig,
) -> Result<String, String> {
    validate_network_config(&config)?;

    if config.mode == "ech" {
        if ech_endpoint(&state).is_err() {
            let sidecar = start_ech_sidecar()?;
            *state
                .ech
                .lock()
                .map_err(|_| "ECH 侧车状态不可用".to_owned())? = Some(sidecar);
        }
        let (port, token) = ech_endpoint(&state)?;
        let started = Instant::now();
        let response = state
            .local_client
            .get(format!("http://127.0.0.1:{port}/fetch"))
            .header("X-Novel-Ech-Token", token)
            .header(
                "X-Novel-Ech-Url",
                "https://n.novelia.cc/api/v1/banner/?type=0",
            )
            .header(header::ORIGIN, NOVELIA_ORIGIN)
            .header(header::REFERER, NOVELIA_REFERER)
            .header(header::USER_AGENT, NOVELIA_UA)
            .send()
            .await
            .map_err(|error| format!("ECH 连接失败: {error}"))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("读取 ECH 响应失败: {error}"))?;
        return Ok(format!(
            "ECH 连接成功：HTTP {}，耗时 {} ms，响应 {} 字节",
            status.as_u16(),
            started.elapsed().as_millis(),
            bytes.len()
        ));
    }

    let client = build_client(state.jar.clone(), &config)?;
    let started = Instant::now();
    let response = client
        .get("https://n.novelia.cc/api/v1/banner/?type=0")
        .header(header::ORIGIN, NOVELIA_ORIGIN)
        .header(header::REFERER, NOVELIA_REFERER)
        .header(header::USER_AGENT, NOVELIA_UA)
        .send()
        .await
        .map_err(|error| format!("连接失败: {error}"))?;
    let status = response.status();
    response
        .bytes()
        .await
        .map_err(|error| format!("读取响应失败: {error}"))?;
    Ok(format!(
        "连接成功：HTTP {}，耗时 {} ms",
        status.as_u16(),
        started.elapsed().as_millis()
    ))
}

fn is_skipped_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "origin"
            | "referer"
            | "cookie"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "accept-encoding"
            | "user-agent"
    )
}

fn is_skipped_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
            | "content-encoding"
            | "set-cookie"
            | "set-cookie2"
    )
}

fn apply_cors(headers: &mut HeaderMap, origin: Option<HeaderValue>) {
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.append(header::VARY, HeaderValue::from_static("Origin"));
    }
}

async fn ech_forward(
    state: &AppState,
    port: u16,
    token: &str,
    method: &reqwest::Method,
    upstream_url: &str,
    request_headers: &[(HeaderName, HeaderValue)],
    body: &[u8],
) -> Result<reqwest::Response, String> {
    let url = Url::parse(upstream_url).map_err(|error| format!("上游地址无效: {error}"))?;
    let mut builder = state
        .local_client
        .request(
            method.clone(),
            format!("http://127.0.0.1:{port}/fetch"),
        )
        .header("X-Novel-Ech-Token", token)
        .header("X-Novel-Ech-Url", upstream_url)
        .header(header::ORIGIN, NOVELIA_ORIGIN)
        .header(header::REFERER, NOVELIA_REFERER)
        .header(header::USER_AGENT, NOVELIA_UA);

    for (name, value) in request_headers {
        builder = builder.header(name.clone(), value.clone());
    }
    if let Some(cookie) = state.jar.cookie_header(&url) {
        builder = builder.header(header::COOKIE, cookie);
    }
    if !body.is_empty() {
        builder = builder.body(body.to_vec());
    }

    builder
        .send()
        .await
        .map_err(|error| format!("ECH 侧车请求失败: {error}"))
}

async fn upstream_to_response(
    upstream: reqwest::Response,
    origin: Option<HeaderValue>,
    jar: Option<(&CookieJar, &Url)>,
) -> Response<Body> {
    let status = upstream.status();
    let headers = upstream.headers().clone();

    if let Some((jar, url)) = jar {
        let values: Vec<HeaderValue> = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .cloned()
            .collect();
        jar.store_response_cookies(&values, url);
    }

    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            log::error!("读取上游响应失败: {error}");
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("读取上游响应失败: {error}"),
                origin,
            );
        }
    };

    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() =
        StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in headers.iter() {
        if is_skipped_response_header(name) {
            continue;
        }
        response.headers_mut().insert(name.clone(), value.clone());
    }
    apply_cors(response.headers_mut(), origin);
    response
}

fn text_response(status: StatusCode, message: &str, origin: Option<HeaderValue>) -> Response<Body> {
    let mut response = Response::new(Body::from(message.to_owned()));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    apply_cors(response.headers_mut(), origin);
    response
}

async fn proxy(State(state): State<AppState>, request: Request<Body>) -> Response<Body> {
    let origin = request.headers().get(header::ORIGIN).cloned();

    if request.method() == Method::OPTIONS {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::NO_CONTENT;
        apply_cors(response.headers_mut(), origin.clone());
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        if let Some(requested) = request.headers().get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                requested.clone(),
            );
        }
        return response;
    }

    let path = request.uri().path();
    let query = request
        .uri()
        .query()
        .map(|value| format!("?{value}"))
        .unwrap_or_default();

    let (upstream_base, upstream_path) = if let Some(rest) = path.strip_prefix("/api") {
        (&state.api_base, format!("/api{rest}"))
    } else if let Some(rest) = path.strip_prefix("/auth") {
        (&state.auth_base, rest.to_string())
    } else if let Some(rest) = path.strip_prefix("/forum") {
        // 评论等论坛接口走本地代理，避免 WebView 页面来源（tauri.localhost）被 CORS 拦截。
        (&state.forum_base, rest.to_string())
    } else {
        return text_response(StatusCode::NOT_FOUND, "未知的代理路径", origin);
    };

    let url = format!("{upstream_base}{upstream_path}{query}");
    let method = match reqwest::Method::from_bytes(request.method().as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return text_response(StatusCode::BAD_REQUEST, "无效的请求方法", origin),
    };

    let client = match state.client.read() {
        Ok(client) => client.clone(),
        Err(_) => {
            return text_response(StatusCode::INTERNAL_SERVER_ERROR, "网络客户端不可用", origin);
        }
    };

    let mut request_headers: Vec<(HeaderName, HeaderValue)> = Vec::new();
    for (name, value) in request.headers() {
        if is_skipped_request_header(name) {
            continue;
        }
        request_headers.push((name.clone(), value.clone()));
    }

    let body = match axum::body::to_bytes(request.into_body(), MAX_BODY_SIZE).await {
        Ok(body) => body,
        Err(error) => {
            return text_response(
                StatusCode::BAD_REQUEST,
                &format!("读取请求体失败: {error}"),
                origin,
            );
        }
    };

    let mode = state
        .config
        .read()
        .map(|config| config.mode.clone())
        .unwrap_or_default();

    if mode == "ech" {
        if ech_endpoint(&state).is_err() {
            match start_ech_sidecar() {
                Ok(sidecar) => {
                    if let Ok(mut guard) = state.ech.lock() {
                        *guard = Some(sidecar);
                    }
                }
                Err(error) => {
                    return text_response(StatusCode::BAD_GATEWAY, &error, origin);
                }
            }
        }

        let (port, token) = match ech_endpoint(&state) {
            Ok(endpoint) => endpoint,
            Err(error) => return text_response(StatusCode::BAD_GATEWAY, &error, origin),
        };

        let ech_idempotent =
            method == reqwest::Method::GET || method == reqwest::Method::HEAD;
        let ech_attempts = if ech_idempotent { 2 } else { 1 };
        let mut ech_attempt = 0;
        let upstream = loop {
            match ech_forward(
                &state,
                port,
                &token,
                &method,
                &url,
                &request_headers,
                &body,
            )
            .await
            {
                Ok(upstream) => break Ok(upstream),
                Err(error) => {
                    ech_attempt += 1;
                    if ech_attempt >= ech_attempts {
                        break Err(error);
                    }
                    log::warn!("ECH 桥接请求失败，准备重试（第 {ech_attempt} 次）: {error}");
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        };

        let upstream = match upstream {
            Ok(upstream) => upstream,
            Err(error) => {
                return text_response(StatusCode::BAD_GATEWAY, &error, origin);
            }
        };

        let upstream_url = match Url::parse(&url) {
            Ok(upstream_url) => upstream_url,
            Err(error) => {
                return text_response(
                    StatusCode::BAD_GATEWAY,
                    &format!("上游地址无效: {error}"),
                    origin,
                );
            }
        };

        return upstream_to_response(upstream, origin, Some((&state.jar, &upstream_url))).await;
    }

    let is_idempotent = method == reqwest::Method::GET || method == reqwest::Method::HEAD;
    let attempts = if is_idempotent { 2 } else { 1 };
    let mut attempt = 0;
    let upstream = loop {
        let mut builder = client
            .request(method.clone(), &url)
            .header(header::ORIGIN, NOVELIA_ORIGIN)
            .header(header::REFERER, NOVELIA_REFERER)
            .header(header::USER_AGENT, NOVELIA_UA);
        for (name, value) in &request_headers {
            builder = builder.header(name.clone(), value.clone());
        }
        if !body.is_empty() {
            builder = builder.body(body.clone());
        }

        match builder.send().await {
            Ok(response) => break Ok(response),
            Err(error) => {
                attempt += 1;
                if attempt >= attempts {
                    break Err(error);
                }
                log::warn!("上游请求失败，准备重试（第 {attempt} 次）{url}: {error}");
                tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
            }
        }
    };

    let upstream = match upstream {
        Ok(response) => response,
        Err(error) => {
            log::error!("请求上游失败 {url}: {error}");
            return text_response(
                StatusCode::BAD_GATEWAY,
                &format!("请求上游失败: {error}"),
                origin,
            );
        }
    };

    upstream_to_response(upstream, origin, None).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_network_config,
            set_network_config,
            test_network
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Android 端没有初始化脚本注入，前端构建期固定使用 43110；
            // 桌面端继续使用随机端口并通过初始化脚本注入。
            #[cfg(target_os = "android")]
            let bind_port = 43110_u16;
            #[cfg(not(target_os = "android"))]
            let bind_port = 0_u16;

            let listener = tauri::async_runtime::block_on(async {
                tokio::net::TcpListener::bind(("127.0.0.1", bind_port)).await
            })?;
            let port = listener.local_addr()?.port();

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let cookie_path = data_dir.join("cookies.json");
            let config_path = data_dir.join("network.json");
            let jar = CookieJar::new(cookie_path);

            let config = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|text| serde_json::from_str::<NetworkConfig>(&text).ok())
                .unwrap_or_default();
            let client = build_client(jar.clone(), &config)?;
            let local_client = Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(90))
                .build()?;

            #[cfg(target_os = "android")]
            let ech_state: Option<EchSidecar> = None;
            #[cfg(not(target_os = "android"))]
            let ech_state = match start_ech_sidecar() {
                Ok(sidecar) => {
                    log::info!("ECH 侧车已启动，端口 {}", sidecar.port);
                    Some(sidecar)
                }
                Err(error) => {
                    log::warn!("{error}");
                    None
                }
            };

            let state = AppState {
                client: Arc::new(RwLock::new(client)),
                local_client,
                jar,
                config: Arc::new(RwLock::new(config)),
                config_path,
                ech: Arc::new(Mutex::new(ech_state)),
                api_base: "https://n.novelia.cc".to_owned(),
                auth_base: "https://auth.novelia.cc".to_owned(),
                forum_base: "https://forum.novelia.cc".to_owned(),
            };

            app.manage(state.clone());

            let router = Router::new()
                .fallback(any(proxy))
                .with_state(state);

            tauri::async_runtime::spawn(async move {
                if let Err(error) = axum::serve(listener, router).await {
                    log::error!("本地代理服务退出: {error}");
                }
            });

            // 桌面端程序化创建窗口并注入运行时配置；移动端由 Tauri 按
            // tauri.android.conf.json 的窗口配置创建，前端使用构建期基址。
            #[cfg(desktop)]
            {
                let init_script = format!(
                    "Object.defineProperty(window, '__NOVELIA_RUNTIME__', {{ \
                        value: Object.freeze({{ \
                            apiBase: 'http://127.0.0.1:{port}/api/', \
                            authBase: 'http://127.0.0.1:{port}/auth/', \
                            forumApiBase: 'http://127.0.0.1:{port}/forum/', \
                            echAvailable: true \
                        }}), \
                        configurable: false \
                    }});"
                );

                // 论坛是独立域名，登录态存在 web-kit 的 localStorage 里，且它的页面
                // 没有做安全区适配。这里在跳转前把登录态放进 URL hash，论坛页加载时
                // 再写回 localStorage，并补上与主站一致的顶部安全区样式。
                let forum_bridge = r#"
(function () {
  if (window.__noveliaForumBridge) return;
  window.__noveliaForumBridge = true;
  var SESSION_KEY = 'web-kit:session:v1';
  var ORIGIN_KEY = 'novelia:app-origin';
  var FORUM_HOST = 'forum.novelia.cc';
  var APP_ORIGIN_FALLBACK = 'http://tauri.localhost';

  if (location.hostname === FORUM_HOST) {
    var appOrigin = APP_ORIGIN_FALLBACK;
    try {
      var sessionMatch = /novelia-session=([^&]+)/.exec(location.hash);
      if (sessionMatch) {
        localStorage.setItem(SESSION_KEY, decodeURIComponent(sessionMatch[1]));
      }
      var originMatch = /novelia-origin=([^&]+)/.exec(location.hash);
      if (originMatch) {
        appOrigin = decodeURIComponent(originMatch[1]);
        localStorage.setItem(ORIGIN_KEY, appOrigin);
      } else {
        var storedOrigin = localStorage.getItem(ORIGIN_KEY);
        if (storedOrigin) appOrigin = storedOrigin;
      }
      if (sessionMatch || originMatch) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    } catch (error) {}
    var css = '.web-kit-layout{--web-kit-header-height:calc(50px + var(--novelia-inset-top, 0px));}'
      + '.web-kit-layout>div>header{padding-top:var(--novelia-inset-top, 0px);}';
    var append = function () {
      if (!document.head) return;
      var style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) append();
    else document.addEventListener('DOMContentLoaded', append, { once: true });

    // 论坛里指向小说站的链接要回到应用内的 SPA，直接加载远程站点会丢掉
    // 客户端布局、安全区适配和本地代理。
    document.addEventListener('click', function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      var url;
      try { url = new URL(anchor.href, location.href); } catch (error) { return; }
      if (url.hostname !== 'n.novelia.cc' && url.hostname !== 'novelia.cc') return;
      event.preventDefault();
      event.stopPropagation();
      location.href = appOrigin + url.pathname + url.search + url.hash;
    }, true);
    return;
  }

  document.addEventListener('click', function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    var url;
    try { url = new URL(anchor.href, location.href); } catch (error) { return; }
    if (url.hostname !== FORUM_HOST) return;
    var session = null;
    try { session = localStorage.getItem(SESSION_KEY); } catch (error) {}
    var hash = 'novelia-origin=' + encodeURIComponent(location.origin);
    if (session) hash += '&novelia-session=' + encodeURIComponent(session);
    url.hash = hash;
    event.preventDefault();
    event.stopPropagation();
    location.href = url.toString();
  }, true);
})();
"#;

                let init_script = format!("{init_script}{forum_bridge}");

                let builder =
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                        .title("Novelia")
                        .inner_size(1280.0, 800.0)
                        .min_inner_size(960.0, 640.0)
                        .center()
                        .initialization_script(&init_script);

                // 调试构建开放 CDP，便于用脚本检查真实 WebView 的 DOM 与请求；
                // 正式包仅在显式设置 NOVELIA_CDP 时开启，用于发布前联调。
                let builder =
                    if cfg!(debug_assertions) || std::env::var_os("NOVELIA_CDP").is_some() {
                        builder.additional_browser_args("--remote-debugging-port=9222")
                    } else {
                        builder
                    };

                builder.build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
