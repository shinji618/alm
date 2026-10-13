// 로그인: 회사 이메일 → BFF /auth/login(도메인으로 회사 IdP를 찾아 이동) → 로그인 후 원래 화면으로 돌아온다
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, FormGrid, Panel, TextField } from '@/components/ui';
import { loginUrl } from '@/lib/api';
import s from './assets/assets.module.css';

const EMAIL = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function Login() {
  const { t } = useTranslation();
  const [email, setEmail] = useState(() => { try { return localStorage.getItem('alm.email') ?? ''; } catch { return ''; } });
  const [error, setError] = useState<string>();
  const submit = () => {
    if (!EMAIL.test(email.trim())) return setError(t('login.invalid'));
    try { localStorage.setItem('alm.email', email.trim()); } catch { /* ignore */ }
    const back = `${window.location.pathname}${window.location.search}`;
    window.location.assign(loginUrl(email.trim(), back.startsWith('/') ? back : '/'));
  };
  return (
    <div className={s.loginWrap}>
      <div className={s.loginCard}>
        <Panel title={t('login.title')} subtitle={t('login.subtitle')}>
          <FormGrid onSubmit={submit}>
            <TextField label={t('login.email')} type="email" autoComplete="email" full required value={email} error={error}
              onChange={(e) => { setEmail(e.target.value); setError(undefined); }} />
            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="primary" type="submit">{t('login.submit')}</Button>
            </div>
          </FormGrid>
        </Panel>
      </div>
    </div>
  );
}
