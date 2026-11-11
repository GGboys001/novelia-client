import { pinia } from './pinia';
import { webKit } from './webKit';
import { PiniaColada } from '@pinia/colada';

import App from './App.vue';
import router from './router';
import './style.css';
import { installDownloadProgressListener } from './stores/useDownloadStore';
import { installDownloadInterceptor } from './util/download';

installDownloadInterceptor();
installDownloadProgressListener();

const app = createApp(App);

app.use(pinia);
app.use(PiniaColada, {
  queryOptions: {
    gcTime: 3600_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  },
});

app.use(webKit);
app.use(router);
app.mount('#app');
