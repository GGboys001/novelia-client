import { clamp } from 'lodash-es';

const THROTTLE_MS = 100;

export function useScrollDetector(
  onScroll: (payload: {
    percent: number;
    chapterId: string;
    y: number;
    paragraphIndex?: number;
  }) => void,
) {
  let lastRun = 0;

  const handler = () => {
    const now = Date.now();
    if (now - lastRun < THROTTLE_MS) return;
    lastRun = now;

    const chapters = Array.from(document.querySelectorAll('[data-chapter]'));
    if (chapters.length === 0) return;

    const vh = window.innerHeight;

    for (const chapter of chapters) {
      const rect = chapter.getBoundingClientRect();
      const indicator = vh * 0.3;
      if (rect.top <= indicator && rect.bottom >= indicator) {
        const chapterId = chapter.getAttribute('data-id') || '';
        const percent = clamp((indicator - rect.top) / rect.height, 0, 1);
        const point = document.elementFromPoint(
          window.innerWidth / 2,
          indicator,
        );
        const paragraphEl = point?.closest('[data-paragraph-index]');
        const paragraphIndex =
          paragraphEl?.getAttribute('data-paragraph-index') ?? undefined;
        onScroll({
          percent,
          chapterId,
          y: Math.max(-rect.top, 0),
          paragraphIndex:
            paragraphIndex !== undefined ? Number(paragraphIndex) : undefined,
        });
        break;
      }
    }
  };

  window.addEventListener('scroll', handler, { passive: true });
  onScopeDispose(() => window.removeEventListener('scroll', handler));
}
