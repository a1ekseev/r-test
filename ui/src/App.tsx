import { CSPProvider } from '@base-ui/react/csp-provider';
import { Select } from '@base-ui/react/select';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FormattedMessage, IntlProvider } from 'react-intl';
import { confirmCode, requestCode, type Session, type Status, status } from './ipc';
import { type Locale, locales, messages } from './messages';
import * as problems from './problems';

type Step = { kind: 'email' } | { kind: 'code'; email: string } | { kind: 'done'; session: Session };

export function App() {
  const [locale, setLocale] = useState<Locale>('en');
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<Status>();
  const [instances, setInstances] = useState(0);
  const problemCount = useSyncExternalStore(problems.subscribe, problems.count);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    status().then(setInfo, (e: unknown) => problems.add(`status: ${String(e)}`));
    const unlisten = listen('second-instance', () => setInstances((n) => n + 1));
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      if (step.kind === 'email') {
        await requestCode(value);
        setStep({ kind: 'code', email: value });
      } else if (step.kind === 'code') {
        setStep({ kind: 'done', session: await confirmCode(step.email, value) });
      }
      setValue('');
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <IntlProvider locale={locale} messages={messages[locale]}>
      <header>
        <h1>Probe</h1>
        {/* The select would otherwise inject an inline <style> element, which style-src 'self' blocks. */}
        <CSPProvider disableStyleElements>
          <Select.Root items={locales} value={locale} onValueChange={(next) => next && setLocale(next)}>
            <Select.Trigger className="select-trigger" data-testid="language" aria-label="Language">
              <Select.Value />
            </Select.Trigger>
            <Select.Portal>
              <Select.Positioner>
                <Select.Popup className="select-popup">
                  {locales.map(({ value: item, label }) => (
                    <Select.Item key={item} value={item} className="select-item" data-testid={`language-${item}`}>
                      <Select.ItemText>{label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Positioner>
            </Select.Portal>
          </Select.Root>
        </CSPProvider>
        <button type="button" data-testid="about" onClick={() => dialog.current?.showModal()}>
          <FormattedMessage id="about" />
        </button>
      </header>

      <main>
        {step.kind === 'done' ? (
          <section>
            <p data-testid="signed-in">
              <FormattedMessage id="signedIn" />
            </p>
            <dl>
              <dt>secret store</dt>
              <dd data-testid="stored">{step.session.stored ? 'yes' : 'no'}</dd>
              <dt>websocket pong</dt>
              <dd data-testid="pong">{step.session.pong}</dd>
            </dl>
            <p data-testid="message">{step.session.message}</p>
            {/* the same image twice: straight from the demo server, and through the app's own protocol */}
            {info && <img data-testid="image-direct" alt="" src={`${info.serverUrl}/image/${step.session.image}`} />}
            <img data-testid="image-proxied" alt="" src={convertFileSrc(step.session.image, 'probe')} />
          </section>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label htmlFor={step.kind}>
              <FormattedMessage id={step.kind} />
            </label>
            <input id={step.kind} value={value} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
            <button type="submit" disabled={value === ''}>
              <FormattedMessage id={step.kind === 'email' ? 'requestCode' : 'signIn'} />
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        )}
      </main>

      <footer>
        <dl>
          <dt>version</dt>
          <dd data-testid="version">{info?.version}</dd>
          <dt>os</dt>
          <dd data-testid="os">
            {info?.os} {info?.arch}
          </dd>
          <dt>server</dt>
          <dd data-testid="server">{info ? (info.server ? 'up' : 'down') : ''}</dd>
          <dt>incognito</dt>
          <dd data-testid="incognito">{info ? (info.incognito ? 'yes' : 'no') : ''}</dd>
          <dt>second launches</dt>
          <dd data-testid="instances">{instances}</dd>
          <dt>problems</dt>
          <dd data-testid="problems">{problemCount}</dd>
        </dl>
        <p>
          <FormattedMessage id="problems" values={{ count: problemCount }} />
        </p>
        <pre data-testid="problem-list">{problems.all().join('\n')}</pre>
      </footer>

      <dialog ref={dialog} data-testid="about-dialog">
        <p>
          <FormattedMessage id="aboutText" values={{ b: (chunks) => <b>{chunks}</b> }} />
        </p>
        <button type="button" data-testid="about-close" onClick={() => dialog.current?.close()}>
          <FormattedMessage id="close" />
        </button>
      </dialog>
    </IntlProvider>
  );
}
