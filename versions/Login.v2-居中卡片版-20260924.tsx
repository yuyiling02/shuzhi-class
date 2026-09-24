import React, { FormEvent, useMemo, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Fingerprint, ShieldCheck, UserPlus } from 'lucide-react';

export type AuthRole = 'user' | 'admin';

export interface AuthUser {
  id: number;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  school?: string | null;
  lastAccessAt?: string | null;
  lastAccessIp?: string | null;
  role: AuthRole;
  status: 'active' | 'disabled';
  theme?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface LoginProps {
  onAuthenticated: (user: AuthUser) => void;
  onBack: () => void;
}

type AuthMode = 'login' | 'register' | 'admin';

/**
 * 顶部两个页签只区分「用户侧 / 管理员侧」。
 * 注册属于用户侧的子状态，由底部的「注册」文字链接进入，
 * 因此 mode === 'register' 时仍然点亮「用户登录」页签。
 */
type AuthTab = 'user' | 'admin';

const modeConfig = {
  login: {
    title: '用户登录',
    subtitle: '进入 3D 智慧课堂控制台',
    icon: Fingerprint,
    endpoint: '/api/auth/login',
    submit: '登录',
  },
  register: {
    title: '注册账号',
    subtitle: '创建普通用户账号，进入 3D 智慧课堂',
    icon: UserPlus,
    endpoint: '/api/auth/register',
    submit: '注册',
  },
  admin: {
    title: '管理员登录',
    subtitle: '进入管理后台或课堂操作界面',
    icon: ShieldCheck,
    endpoint: '/api/auth/admin/login',
    submit: '管理员登录',
  },
} satisfies Record<AuthMode, {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  endpoint: string;
  submit: string;
}>;

const tabConfig = {
  user: { label: '用户登录', fallbackMode: 'login' },
  admin: { label: '管理员', fallbackMode: 'admin' },
} satisfies Record<AuthTab, { label: string; fallbackMode: AuthMode }>;

async function readError(response: Response) {
  try {
    const data = await response.json();
    return data.message || '请求失败';
  } catch {
    return '请求失败';
  }
}

/** 版式尺寸：与设计稿实测对齐（卡片内边距 42、控件高 60、正文 17.5） */
const BODY_TEXT = 'text-[17.5px]';

/** 浅色输入框 / 主按钮的固定配色，保证在深色卡片上依然清晰 */
const inputClass = `h-[60px] w-full rounded-xl bg-[#E8F0FE] px-5 ${BODY_TEXT} font-medium text-[#0B1220] outline-none transition placeholder:font-normal placeholder:text-[#0B1220]/35 focus:bg-[#F2F7FF] focus:ring-2 focus:ring-cyan/60`;

const Login: React.FC<LoginProps> = ({ onAuthenticated, onBack }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [school, setSchool] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const config = modeConfig[mode];
  const ModeIcon = config.icon;
  const activeTab: AuthTab = mode === 'admin' ? 'admin' : 'user';

  const helperText = useMemo(() => {
    if (mode === 'admin') return '管理员账号由系统管理员创建。';
    if (mode === 'register') return '注册成功后会自动进入课堂。学校为选填项，密码需为 6-128 位。';
    return '使用已注册的普通用户账号登录。';
  }, [mode]);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setMessage('');
    setConfirmPassword('');
    if (next !== 'register') setSchool('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');

    if (mode === 'register' && password !== confirmPassword) {
      setMessage('两次输入的密码不一致');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          ...(mode === 'register' && school.trim() ? { school: school.trim() } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error(await readError(response));
      }

      const data = await response.json();
      onAuthenticated(data.user);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : mode === 'register' ? '注册失败，请稍后重试' : '登录失败，请稍后重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-login-page min-h-screen bg-[var(--theme-bg)] text-ink overflow-hidden relative flex items-center justify-center px-5 py-10">
      <div className="auth-login-bg absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(var(--theme-accent-rgb),0.24),transparent_34%),radial-gradient(circle_at_80%_10%,rgba(var(--theme-primary-rgb),0.20),transparent_32%),linear-gradient(135deg,var(--theme-bg)_0%,var(--theme-bg-soft)_48%,var(--theme-bg)_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-56 bg-[radial-gradient(ellipse_at_bottom,rgba(var(--theme-accent-rgb),0.22),transparent_70%)]" />

      <button
        onClick={onBack}
        className="fixed left-6 top-6 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-line/10 bg-white/5 text-ink/70 backdrop-blur-md transition hover:bg-white/10 hover:text-ink"
        aria-label="返回首页"
        title="返回首页"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>

      <section className="auth-login-card relative z-10 w-full max-w-[529px] overflow-hidden rounded-[22px] border border-cyan/30 bg-[var(--theme-bg-soft)]/60 p-[42px] backdrop-blur-2xl shadow-[0_24px_70px_rgba(var(--theme-accent-rgb),0.16)] ring-1 ring-white/5">
        {/* 顶部与侧边的蓝色边缘光 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/80 to-transparent" />
        <div className="pointer-events-none absolute left-0 top-0 h-full w-px bg-gradient-to-b from-transparent via-cyan-400/30 to-transparent" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-cyan-500/10 to-transparent mix-blend-screen" />
        <div className="pointer-events-none absolute inset-0 bg-white/[0.03]" />

        <div className="relative z-10">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-[14px] border border-cyan/25 bg-cyan/10 text-cyan">
            <ModeIcon className="h-6 w-6" />
          </div>

          <h1 className="mt-6 text-[30px] font-bold leading-tight tracking-normal text-ink">{config.title}</h1>
          <p className={`mt-3 ${BODY_TEXT} text-ink/55`}>{config.subtitle}</p>

          <div className="mt-7 grid grid-cols-2 gap-1 rounded-[14px] border border-cyan/20 bg-white/[0.06] p-[5px]">
            {(Object.keys(tabConfig) as AuthTab[]).map((tab) => {
              const isActive = activeTab === tab;

              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => switchMode(tabConfig[tab].fallbackMode)}
                  className={`h-[50px] rounded-[10px] ${BODY_TEXT} transition ${
                    isActive
                      ? 'bg-white font-bold text-[#0B1220]'
                      : 'font-medium text-ink/55 hover:bg-white/[0.06] hover:text-ink/85'
                  }`}
                >
                  {tabConfig[tab].label}
                </button>
              );
            })}
          </div>

          <form onSubmit={submit} className="mt-8 space-y-6">
            <label className="block">
              <span className={`${BODY_TEXT} font-medium text-ink/75`}>用户名</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className={`mt-2.5 ${inputClass}`}
                placeholder={mode === 'admin' ? 'admin' : '请输入用户名'}
                autoComplete="username"
                required
              />
            </label>

            <label className="block">
              <span className={`${BODY_TEXT} font-medium text-ink/75`}>密码</span>
              <div className="relative mt-2.5">
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className={`${inputClass} pr-12`}
                  placeholder="请输入密码"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[#0B1220]/35 transition hover:bg-[#0B1220]/5 hover:text-[#0B1220]/70"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            {mode === 'register' && (
              <>
                <label className="block">
                  <span className={`${BODY_TEXT} font-medium text-ink/75`}>确认密码</span>
                  <input
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    className={`mt-2.5 ${inputClass}`}
                    placeholder="请再次输入密码"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label className="block">
                  <span className={`${BODY_TEXT} font-medium text-ink/75`}>学校（可选）</span>
                  <input
                    value={school}
                    onChange={(event) => setSchool(event.target.value)}
                    maxLength={128}
                    className={`mt-2.5 ${inputClass}`}
                    placeholder="请输入学校名称（可选）"
                    autoComplete="organization"
                  />
                </label>
              </>
            )}

            <p className={`-mt-1 ${BODY_TEXT} leading-relaxed text-ink/45`}>{helperText}</p>

            {message && (
              <div className="rounded-xl border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {message}
              </div>
            )}

            <div className="pt-[18px]">
              <button
                type="submit"
                disabled={isSubmitting}
                className={`inline-flex h-[60px] w-full items-center justify-center gap-2.5 rounded-xl bg-cyan-400 px-5 ${BODY_TEXT} font-bold text-[#061520] transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <ModeIcon className="h-[18px] w-[18px]" />
                {isSubmitting ? '处理中...' : config.submit}
              </button>
            </div>

            <div className="-mt-0.5 text-center">
              {mode === 'register' ? (
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className={`${BODY_TEXT} font-semibold text-ink/90 transition hover:text-cyan`}
                >
                  已有账号，返回登录
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => switchMode('register')}
                  className={`${BODY_TEXT} font-semibold text-ink/90 transition hover:text-cyan`}
                >
                  注册
                </button>
              )}
            </div>
          </form>
        </div>
      </section>
    </div>
  );
};

export default Login;
