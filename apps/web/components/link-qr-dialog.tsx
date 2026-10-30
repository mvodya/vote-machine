'use client';
import {useI18n} from './language-provider';
import {useState} from 'react';
import {ExternalLink} from 'lucide-react';
import {Dialog} from './ui/dialog';
import {Button} from './ui/button';
import {Spinner} from './ui/loading';
// Use the protected PNG route for both the preview and its own page
export function LinkQrDialog({
  roomId,
  linkId,
  name,
  onClose,
}: {
  roomId: string;
  linkId: string;
  name: string;
  onClose: () => void;
}) {
  const {t} = useI18n();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const path = `/api/rooms/${roomId}/links/${linkId}/qr`;
  return (
    <Dialog title="QR Code" onClose={onClose}>
      <p className="mb-4 break-words text-sm text-muted">{name}</p>
      {loading && !failed && (
        <div
          role="status"
          aria-label={t('Загружаем QR код')}
          className="flex aspect-square items-center justify-center"
        >
          <Spinner />
        </div>
      )}
      {!failed && (
        <>
          {/* Keep this authenticated image outside the public image cache */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={attempt}
            src={`${path}?attempt=${attempt}`}
            width={768}
            height={768}
            alt={t('QR код ссылки: {value0}', {value0: name})}
            onLoad={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setFailed(true);
            }}
            className={`aspect-square w-full rounded-xl border border-border bg-white ${loading ? 'hidden' : ''}`}
          />
        </>
      )}
      {failed && (
        <div role="alert" className="space-y-3 text-sm">
          <p>{t('Не удалось загрузить QR код')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setFailed(false);
              setLoading(true);
              setAttempt((value) => value + 1);
            }}
          >
            {t('Попробовать снова')}
          </Button>
        </div>
      )}
      <Button
        className="mt-5"
        variant="secondary"
        startIcon={<ExternalLink />}
        disabled={loading || failed}
        onClick={() => window.open(path, '_blank', 'noopener,noreferrer')}
      >
        {t('Открыть QR код отдельно')}
      </Button>
    </Dialog>
  );
}
