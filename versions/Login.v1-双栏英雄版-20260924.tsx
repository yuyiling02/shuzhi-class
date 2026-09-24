import React, { FormEvent, useMemo, useState, useRef } from 'react';
import { ArrowLeft, Eye, EyeOff, Fingerprint, Lock, ShieldCheck, UserPlus } from 'lucide-react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Sphere, MeshDistortMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { useTheme } from './components/ThemeProvider';

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

async function readError(response: Response) {
  try {
    const data = await response.json();
    return data.message || '请求失败';
  } catch {
    return '请求失败';
  }
}

function ParticleFlow({ accent }: { accent: string }) {
  const pointsRef = useRef<THREE.Points>(null);
  const count = 1000;
  
  const particles = useMemo(() => {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    return positions;
  }, []);

  useFrame(({ clock }) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = clock.getElapsedTime() * 0.05;
      pointsRef.current.position.y = Math.sin(clock.getElapsedTime() * 0.2) * 0.2;
    }
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.015} color={accent} transparent opacity={0.5} sizeAttenuation />
    </points>
  );
}

function NeuralNetwork({ accent }: { accent: string }) {
  const { particles, lines } = useMemo(() => {
    const particleCount = 150;
    const particles = new Float32Array(particleCount * 3);
    const linePositions: number[] = [];
    const maxDistance = 2.5;

    for (let i = 0; i < particleCount; i++) {
      particles[i * 3] = (Math.random() - 0.5) * 15;
      particles[i * 3 + 1] = (Math.random() - 0.5) * 15;
      particles[i * 3 + 2] = (Math.random() - 0.5) * 15;
    }

    for (let i = 0; i < particleCount; i++) {
      for (let j = i + 1; j < particleCount; j++) {
        const dx = particles[i * 3] - particles[j * 3];
        const dy = particles[i * 3 + 1] - particles[j * 3 + 1];
        const dz = particles[i * 3 + 2] - particles[j * 3 + 2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < maxDistance) {
          linePositions.push(
            particles[i * 3], particles[i * 3 + 1], particles[i * 3 + 2],
            particles[j * 3], particles[j * 3 + 1], particles[j * 3 + 2]
          );
        }
      }
    }

    return { particles, lines: new Float32Array(linePositions) };
  }, []);

  const groupRef = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (groupRef.current) {
      groupRef.current.rotation.y = clock.getElapsedTime() * 0.03;
      groupRef.current.rotation.x = clock.getElapsedTime() * 0.02;
    }
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={particles.length / 3} array={particles} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial size={0.03} color={accent} transparent opacity={0.5} sizeAttenuation />
      </points>
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={lines.length / 3} array={lines} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial color={accent} transparent opacity={0.15} />
      </lineSegments>
    </group>
  );
}

const Login: React.FC<LoginProps> = ({ onAuthenticated, onBack }) => {
  const [mode, setMode] = useState<AuthMode>('login');
  const [username, setUsername] = useState('');
  const [school, setSchool] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { themeDef } = useTheme();

  const config = modeConfig[mode];
  const ModeIcon = config.icon;
  const helperText = useMemo(() => {
    if (mode === 'admin') return '管理员账号由系统管理员创建。';
    if (mode === 'register') return '注册成功后会自动进入课堂。学校为选填项，密码需为 6-128 位。';
    return '使用已注册的普通用户账号登录。';
  }, [mode]);

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

      <div className="relative z-10 w-full max-w-[980px] grid gap-8 lg:grid-cols-[1fr_420px] items-center">
        <section className="auth-login-copy hidden lg:flex flex-col justify-center relative h-full min-h-[500px]">
          {/* 3D Showcase */}
          <div className="absolute inset-0 z-0 opacity-80 pointer-events-none">
            <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>
              <NeuralNetwork accent={themeDef.accent} />
              <ParticleFlow accent={themeDef.accent} />
            </Canvas>
          </div>
          
          <div className="relative z-10 pl-8 border-l-2 border-cyan/30">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan/20 bg-cyan-300/10 px-4 py-2 text-sm text-cyan mb-6">
              <Lock className="h-4 w-4" />
              Secure Classroom Access
            </div>
            <h1 className="text-5xl font-black leading-tight tracking-normal text-ink drop-shadow-lg">
              探索微观与宏观<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500">重塑教学体验</span>
            </h1>
            <p className="mt-6 text-lg text-cyan/70 max-w-md leading-relaxed font-medium">
              结合空间手势与多模态AI大模型，将枯燥的抽象知识点转化为可触碰的 3D 互动教具，开启全息智慧课堂新纪元。
            </p>
          </div>
        </section>

        <section className="auth-login-card relative rounded-2xl border border-cyan/30 bg-white/[0.03] p-8 backdrop-blur-3xl shadow-[0_20px_50px_rgba(var(--theme-accent-rgb),0.15)] ring-1 ring-white/10 overflow-hidden">
          {/* 蓝色边缘光与半透明渐变 */}
          <div className="absolute inset-x-0 -top-px h-px w-full bg-gradient-to-r from-transparent via-cyan-400/80 to-transparent" />
          <div className="absolute -left-px top-0 w-px h-full bg-gradient-to-b from-transparent via-cyan-400/30 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-b from-cyan-500/10 to-transparent pointer-events-none mix-blend-screen" />
          
          <div className="relative z-10 flex items-start justify-between gap-4">
            <div>
              <div className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-cyan/25 bg-cyan-300/10 text-cyan">
                <ModeIcon className="h-5 w-5" />
              </div>
              <h2 className="mt-5 text-2xl font-bold tracking-normal">{config.title}</h2>
              <p className="mt-2 text-sm text-ink/55">{config.subtitle}</p>
            </div>
          </div>

          <div className="relative z-10 mt-6 grid grid-cols-3 gap-2 rounded-lg border border-line/10 bg-white/[0.03] p-1">
            {([
              ['login', '用户登录'],
              ['register', '注册账号'],
              ['admin', '管理员'],
            ] as const).map(([value, label]) => {
              const isActive = mode === value;

              return (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setMessage('');
                  setConfirmPassword('');
                  if (value !== 'register') setSchool('');
                }}
                className={`h-10 rounded-md text-sm font-semibold transition ${isActive ? 'bg-white text-black' : 'text-ink/60 hover:bg-white/8 hover:text-ink'}`}
              >
                {label}
              </button>
              );
            })}
          </div>

          <form onSubmit={submit} className="relative z-10 mt-6 space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-ink/70">用户名</span>
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.04] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.07]"
                placeholder={mode === 'admin' ? 'admin' : '请输入用户名'}
                autoComplete="username"
                required
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-ink/70">密码</span>
              <div className="relative mt-2">
                <input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 w-full rounded-lg border border-line/10 bg-white/[0.04] px-4 pr-12 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.07]"
                  placeholder="请输入密码"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 grid h-8 w-8 place-items-center rounded-md text-ink/40 transition hover:bg-white/10 hover:text-ink/80"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            {mode === 'register' && (
              <>
              <label className="block">
                <span className="text-sm font-medium text-ink/70">确认密码</span>
                <input
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.04] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.07]"
                  placeholder="请再次输入密码"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-ink/70">学校（可选）</span>
                <input
                  value={school}
                  onChange={(event) => setSchool(event.target.value)}
                  maxLength={128}
                  className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.04] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.07]"
                  placeholder="请输入学校名称（可选）"
                  autoComplete="organization"
                />
              </label>
              </>
            )}

            <p className="h-10 text-sm text-ink/45 flex items-start">{helperText}</p>

            {message && (
              <div className="rounded-lg border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {message}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-cyan-200 px-5 text-sm font-bold text-[#03111f] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ModeIcon className="h-4 w-4" />
              {isSubmitting ? '处理中...' : config.submit}
            </button>

          </form>
        </section>
      </div>
    </div>
  );
};

export default Login;
