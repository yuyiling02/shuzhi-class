
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { AgentRole, AgentStatus, AgentTimelineItem, AgentToolCall, FollowUpQuestion, ControlRefs, InteractionMode, TeachingModelId, type LearningMemory, type MemorySettings } from './types';
import HandController from './components/HandController';
import ModelViewer from './components/ModelViewer';
import BioDigitalViewer from './components/BioDigitalViewer';
import VoiceController from './components/VoiceController';
import QuizOverlay from './components/QuizOverlay';
import WrongQuestionBook from './components/WrongQuestionBook';
import XiaozhiAssistant, { XiaozhiVisualState } from './components/XiaozhiAssistant';
import XiaozhiMascot from './components/XiaozhiMascot';
import ThemeSwitcher from './components/ThemeSwitcher';
import FollowUpQuestionOverlay from './components/FollowUpQuestionOverlay';
import MultiAgentPanel from './components/MultiAgentPanel';
import ModelDetailPanel, { type DetailPanelTab } from './components/ModelDetailPanel';
import { buildTeachingPlan, getTeachingModelName, inferTeachingModel, buildKnowledgeExplanation, buildOrchestratorDecision, buildFollowUpQuestion, getAutonomousDisassemblyArgs } from './services/agentRuntime';
import { Sparkles, Box, Atom, Globe, ChevronDown, ChevronLeft, ChevronRight, MessageSquare, Hand, ScanFace, Move3d, Maximize2, Minimize2, FlaskConical, Heart, Settings, ShieldCheck, X, ClipboardCheck, Loader2, LockKeyhole, Play, Download, LogOut, Upload, FolderOpen, Trash2, Volume2, Info, PanelRightOpen, BookOpenCheck, Mic, Star } from 'lucide-react';
import { ModelType } from './types';
import type { AuthUser } from './Login';
import { getLocalModel, listLocalModels, deleteLocalModel, hideStaticModel, listHiddenStaticModelIds, saveUploadedModel, type LocalModelSummary } from './services/localModelLibrary';
import { fetchResourceLibrary, type ResourceIconKey, type ResourceTag } from './services/resourceLibrary';
import { createXiaozhiSpeechSession, isXiaozhiSpeechActive, prepareXiaozhiSpeech, speakXiaozhi, stopXiaozhiSpeech, setXiaozhiVoicePreference, subscribeXiaozhiSpeechActivity, type VoicePreference, type XiaozhiSpeechSession } from './services/xiaozhiSpeechService';
import { appendLearningMessage, clearLearningMemories, deleteLearningMemory, listLearningMemories, openLearningSession, updateLearningMemory, updateMemorySettings } from './services/learningMemory';
import { submitWrongQuestions } from './services/quizWrongBook';
import { logUserActivity } from './services/userActivityLog';
import { shouldNarrateKnowledgeAfterFollowUp, type PendingKnowledgeNarration } from './services/followUpAnswer';
import { getAssistantStateAfterKnowledgeClose, isVoiceInputLockedByAssistantState, shouldFinishVoiceTurnAfterKnowledgeClose, shouldInterruptTeachingPresentationForFinalUtterance, type VoiceActivationRequest, type VoiceRecognitionState } from './services/voiceInputLifecycle';
import { getModelInfoProfile, getModelSeedKeyByUrl } from './services/modelInfoProfiles';
import { decideTeachingModelLoad, isCurrentModelLoadEvent, TeachingModelLoadError } from './services/teachingModelLoadState';

const BIODIGITAL_HEART_URL = 'https://human.biodigital.com/view?id=7F0a&lang=zh&ref=share';
const BUILT_IN_MODELS = {
  heart: '/models/heart-optimized.glb',
  hiv: '/models/hiv-virus.glb',
  diamond: '/models/diamond.glb',
  diamondUnitCell: '/models/diamond-unit-cell_NIH3D.glb',
  pubchem6233: '/models/pubchem-6233-bas-color-print_NIH3D.glb',
  nacl: '/models/nacl-crystal.glb',
  sio2: '/models/sio2-crystal.glb',
  nitrobenzene: '/models/7416-bas-color-print_NIH3D.glb',
  brain: '/models/organ-brain.glb',
  organHeart: '/models/organ-heart.glb',
  organLungs: '/models/organ-lungs.glb',
  organLiver: '/models/organ-liver.glb',
  organKidneys: '/models/organ-kidneys.glb',
  organEyeball: '/models/organ-eyeball.glb',
  organIntestine: '/models/organ-intestine.glb',
  organPancreas: '/models/organ-pancreas.glb',
  organSkin: '/models/organ-skin.glb',
  naili: '/models/naili.glb',
  nailiguozi: '/models/nailiguozi.glb',
  xiaoshaoqing: '/models/xiaoshaoqing.glb',
  lanjingling: '/models/lanjingling.glb',
} as const;

// 本次接入的 3 个解剖模型（心脏解剖 / 大脑 / 肺部）
// 规则：单向拆解，不做部件归位；拆解参数复用心脏那套
const ONE_WAY_ANATOMY_KEYS = ['organ-heart', 'organ-brain', 'organ-lungs'] as const;
const isOneWayAnatomyModel = (url?: string, id?: string): boolean => {
  if (url && ONE_WAY_ANATOMY_KEYS.some((key) => url.includes(key))) return true;
  return !!id && (id === 'organHeart' || id === 'brain' || id === 'organLungs');
};

type StaticModel = {
  id: string;
  name: string;
  url: string;
};

const MY_STATIC_MODELS: readonly StaticModel[] = [];
const DIAMOND_STRUCTURE_IMAGE = '/images/diamond-structure.png';
const DICHLOROTOLUENE_STRUCTURE_IMAGE = '/images/dichlorotoluene-structure.png';
const NITROBENZENE_STRUCTURE_IMAGE = '/images/nitrobenzene-structure.svg';
const HEART_STRUCTURE_IMAGE = '/images/heart-structure.png';
const HIV_STRUCTURE_IMAGE = '/images/hiv-structure.png';
const EARTH_LAYERS_IMAGE = '/images/earth-layers-diagram.png';
const TERRAIN_TOPOGRAPHY_IMAGE = '/images/terrain-topography-diagram.png';
const STRUCTURE_IMAGE_BY_MODEL: Record<string, string> = {
  [BUILT_IN_MODELS.heart]: HEART_STRUCTURE_IMAGE,
  [BUILT_IN_MODELS.hiv]: HIV_STRUCTURE_IMAGE,
  [BUILT_IN_MODELS.diamond]: DIAMOND_STRUCTURE_IMAGE,
  [BUILT_IN_MODELS.diamondUnitCell]: DIAMOND_STRUCTURE_IMAGE,
  [BUILT_IN_MODELS.pubchem6233]: DICHLOROTOLUENE_STRUCTURE_IMAGE,
  [BUILT_IN_MODELS.nitrobenzene]: NITROBENZENE_STRUCTURE_IMAGE,
  '/models/earth-layers.glb': EARTH_LAYERS_IMAGE,
  '/models/terrain-topography.glb': TERRAIN_TOPOGRAPHY_IMAGE,
};
const MODEL_ID_BY_URL: Record<string, TeachingModelId> = {
  [BUILT_IN_MODELS.heart]: 'heart',
  [BUILT_IN_MODELS.hiv]: 'hiv',
  [BUILT_IN_MODELS.diamond]: 'diamond',
  [BUILT_IN_MODELS.diamondUnitCell]: 'diamond_unit_cell',
  [BUILT_IN_MODELS.pubchem6233]: 'pubchem_6233',
  [BUILT_IN_MODELS.nacl]: 'nacl',
  [BUILT_IN_MODELS.sio2]: 'sio2',
  [BUILT_IN_MODELS.nitrobenzene]: 'nitrobenzene',
  [BUILT_IN_MODELS.brain]: 'brain',
  [BUILT_IN_MODELS.organHeart]: 'organ_heart',
  [BUILT_IN_MODELS.organLungs]: 'lungs',
  [BUILT_IN_MODELS.organLiver]: 'liver',
  [BUILT_IN_MODELS.organKidneys]: 'kidneys',
  [BUILT_IN_MODELS.organEyeball]: 'eyeball',
  [BUILT_IN_MODELS.organIntestine]: 'intestine',
  [BUILT_IN_MODELS.organPancreas]: 'pancreas',
  [BUILT_IN_MODELS.organSkin]: 'skin',
  '/models/earth-layers.glb': 'earth_layers',
  '/models/terrain-topography.glb': 'terrain',
};
const MODEL_URL_BY_ID: Partial<Record<TeachingModelId, string>> = Object.fromEntries(
  Object.entries(MODEL_ID_BY_URL).map(([url, modelId]) => [modelId, url]),
) as Partial<Record<TeachingModelId, string>>;
type ActiveContent = 'model' | 'biodigital';
type ModelActivitySource = 'manual' | 'local' | 'resource' | 'ai' | 'fallback';

interface PendingModelActivity {
  modelUrl: string;
  fromModel?: string;
  toModel: string;
  source: ModelActivitySource;
}

interface PendingTeachingModelLoad {
  modelId: TeachingModelId;
  modelUrl: string;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error | DOMException) => void;
  timer: number;
  abortHandler?: () => void;
}

const TEACHING_MODEL_LOAD_TIMEOUT_MS = 30_000;

const LOCAL_MODELS_CATEGORY_KEY = 'local-models';
const SIDEBAR_TAB_STORAGE_PREFIX = 'classroom.sidebar-tab.v1';
const HIDDEN_RESOURCE_TAG_NAMES = new Set(['周田孩子作品']);

const RESOURCE_TAG_ICONS = {
  box: Box,
  flask: FlaskConical,
  heart: Heart,
  globe: Globe,
  atom: Atom,
} satisfies Record<ResourceIconKey, React.ComponentType<{ size?: number; className?: string }>>;

function resourceCategoryKey(tagId: number) {
  return `resource-tag-${tagId}`;
}

const MEMORY_CATEGORY_LABELS: Record<LearningMemory['category'], string> = {
  profile: '学习档案',
  preference: '学习偏好',
  learned_topic: '已学主题',
  weak_point: '薄弱知识点',
  mastery: '掌握情况',
};

const AGENT_STATUS_IDLE: Record<AgentRole, AgentStatus> = {
  orchestrator: 'idle',
  planner: 'idle',
  executor: 'idle',
  evaluator: 'idle',
  questioner: 'idle',
};

const makeAgentStatuses = (patch: Partial<Record<AgentRole, AgentStatus>>): Record<AgentRole, AgentStatus> => ({
  ...AGENT_STATUS_IDLE,
  ...patch,
});

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Interaction aborted', 'AbortError');
};

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new DOMException('Interaction aborted', 'AbortError'));
  const onAbort = () => {
    window.clearTimeout(timer);
    reject(new DOMException('Interaction aborted', 'AbortError'));
  };
  const timer = window.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const INTRO_INSTRUCTION =
  '右手捏合：拖拽 | 右手食指中指并拢：控制旋转\n左手张开/闭合：缩放';

interface DashboardProps {
  playIntro?: boolean;
  initialLocalModelId?: string;
  onBack?: () => void;
  currentUser: AuthUser;
  onLogout: () => void;
  onUserUpdated: (user: AuthUser) => void;
  onOpenModelGeneration: () => void;
  onOpenAdmin?: () => void;
}

async function readError(response: Response) {
  try {
    const data = await response.json();
    return data.message || '请求失败';
  } catch {
    return '请求失败';
  }
}

function userLabel(user: AuthUser) {
  return user.displayName || user.username;
}

function userInitial(user: AuthUser) {
  return userLabel(user).trim().slice(0, 1).toUpperCase() || 'U';
}

function resizeAvatarFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      reject(new Error('请选择 PNG、JPEG 或 WebP 图片'));
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('头像图片不能超过 5MB'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('头像解析失败'));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) {
          reject(new Error('当前浏览器不支持头像处理'));
          return;
        }

        canvas.width = size;
        canvas.height = size;

        const scale = Math.max(size / image.width, size / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        const x = (size - width) / 2;
        const y = (size - height) / 2;

        context.fillStyle = '#071018';
        context.fillRect(0, 0, size, size);
        context.drawImage(image, x, y, width, height);
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

type FeedbackAttachment = { file: File; preview: string; name: string; size: number };

function compressFeedbackImage(file: File): Promise<FeedbackAttachment> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      reject(new Error('请选择 PNG、JPEG 或 WebP 图片'));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      reject(new Error('单张图片不能超过 5MB'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('图片解析失败'));
      image.onload = () => {
        const maxDimension = 1600;
        const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return reject(new Error('当前浏览器不支持图片处理'));
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const outputType = file.type === 'image/png' ? 'image/png' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
        const extension = outputType === 'image/png' ? '.png' : outputType === 'image/webp' ? '.webp' : '.jpg';
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('图片压缩失败'));
          const safeName = file.name.replace(/\.[^.]+$/, '') || 'feedback-image';
          const compressed = new File([blob], `${safeName}${extension}`, { type: outputType });
          resolve({ file: compressed, preview: URL.createObjectURL(compressed), name: compressed.name, size: compressed.size });
        }, outputType, outputType === 'image/png' ? undefined : 0.82);
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

const App: React.FC<DashboardProps> = ({ playIntro = true, initialLocalModelId, onBack, currentUser, onLogout, onUserUpdated, onOpenModelGeneration, onOpenAdmin }) => {
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [modelLoadRevision, setModelLoadRevision] = useState(0);
  const [modelType, setModelType] = useState<ModelType>('glb');
  const [modelAssetUrls, setModelAssetUrls] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState<string>('');
  const [cameraActive, setCameraActive] = useState(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('dual');
  const [activeContent, setActiveContent] = useState<ActiveContent>('model');
  const [isStageFullscreen, setIsStageFullscreen] = useState(false);
  const [isStageAppFullscreen, setIsStageAppFullscreen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set([LOCAL_MODELS_CATEGORY_KEY]));
  const [instructionTab, setInstructionTab] = useState<'gesture' | 'voice'>('gesture');
  const [sidebarTab, setSidebarTab] = useState<'resource' | 'agent'>(() => {
    try {
      const saved = window.localStorage.getItem(`${SIDEBAR_TAB_STORAGE_PREFIX}:${currentUser.id}`);
      return saved === 'agent' || saved === 'resource' ? saved : 'resource';
    } catch {
      return 'resource';
    }
  });
  const [localModels, setLocalModels] = useState<LocalModelSummary[]>([]);
  const [hiddenStaticModelIds, setHiddenStaticModelIds] = useState<string[]>([]);
  const [activeLocalModelId, setActiveLocalModelId] = useState<string | null>(null);
  const [localLibraryError, setLocalLibraryError] = useState('');
  const [isSavingLocalModel, setIsSavingLocalModel] = useState(false);
  const [resourceTags, setResourceTags] = useState<ResourceTag[]>([]);
  const [resourceLibraryError, setResourceLibraryError] = useState('');
  const [isResourceLibraryLoading, setIsResourceLibraryLoading] = useState(true);
  const [activeModelSeedKey, setActiveModelSeedKey] = useState<string | null>(null);
  const [detailPanelOpen, setDetailPanelOpen] = useState(() => window.innerWidth >= 900);
  const [detailPanelTab, setDetailPanelTab] = useState<DetailPanelTab>('info');
  const visibleStaticModels = MY_STATIC_MODELS.filter((model) => !hiddenStaticModelIds.includes(model.id));

  const handleHideStaticModel = async (e: React.MouseEvent, model: typeof MY_STATIC_MODELS[number]) => {
    e.stopPropagation();
    try {
      await hideStaticModel(model.id, currentUser.id);
      setHiddenStaticModelIds((current) => current.includes(model.id) ? current : [...current, model.id]);
      if (modelUrl === model.url) clearLocalModel();
      setAiAnalysis('已从我的模型中移除');
    } catch (err) {
      console.error(err);
      setLocalLibraryError('移除模型失败');
    }
  };

  const handleDeleteLocalModel = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await deleteLocalModel(id, currentUser.id);
      const updatedModels = await listLocalModels(currentUser.id);
      setLocalModels(updatedModels);
      if (activeLocalModelId === id) {
        clearLocalModel();
        setAiAnalysis('已删除本地模型');
      }
    } catch (err) {
      console.error(err);
      setLocalLibraryError('删除模型失败');
    }
  };

  const [introReady, setIntroReady] = useState(!playIntro);
  const [streamedInstruction, setStreamedInstruction] = useState(playIntro ? '' : INTRO_INSTRUCTION);
  const [aiAnalysis, setAiAnalysis] = useState('等待指令中...');

  // Interaction speed settings
  const [showSettings, setShowSettings] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<number>(0);
  const [feedbackScene, setFeedbackScene] = useState<string>('');
  const [feedbackSceneOther, setFeedbackSceneOther] = useState<string>('');
  const [feedbackFeatures, setFeedbackFeatures] = useState<string[]>([]);
  const [feedbackVoiceAccuracy, setFeedbackVoiceAccuracy] = useState<string>('');
  const [feedbackModelClarity, setFeedbackModelClarity] = useState<string>('');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [feedbackMessage, setFeedbackMessage] = useState('');
  const [feedbackAttachments, setFeedbackAttachments] = useState<FeedbackAttachment[]>([]);
  const [profileName, setProfileName] = useState(userLabel(currentUser));
  const [profileAvatar, setProfileAvatar] = useState(currentUser.avatarUrl || '');
  const [profileMessage, setProfileMessage] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isAvatarProcessing, setIsAvatarProcessing] = useState(false);
  const [profileTab, setProfileTab] = useState<'profile' | 'memory' | 'voice' | 'password'>('profile');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [isPasswordSuccess, setIsPasswordSuccess] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [voicePreference, setVoicePreference] = useState<VoicePreference>({ mode: 'system', systemVoiceUri: '', providerVoiceId: '' });
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [providerVoices, setProviderVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [isProviderVoiceAvailable, setIsProviderVoiceAvailable] = useState(false);
  const [isSavingVoice, setIsSavingVoice] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState('');
  const [learningSessionId, setLearningSessionId] = useState<number | null>(null);
  const [memorySettings, setMemorySettings] = useState<MemorySettings>({ memoryEnabled: true, noticeSeen: true });
  const [learningMemories, setLearningMemories] = useState<LearningMemory[]>([]);
  const [isMemoryLoading, setIsMemoryLoading] = useState(false);
  const [memoryMessage, setMemoryMessage] = useState('');
  const [editingMemoryId, setEditingMemoryId] = useState<number | null>(null);
  const [editingMemoryContent, setEditingMemoryContent] = useState('');
  const [zoomSpeedMultiplier, setZoomSpeedMultiplier] = useState(0.8);
  const [rotationSpeedMultiplier, setRotationSpeedMultiplier] = useState(5.0);
  const [showLabels, setShowLabels] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<Record<AgentRole, AgentStatus>>(AGENT_STATUS_IDLE);
  const [agentTimeline, setAgentTimeline] = useState<AgentTimelineItem[]>([]);
  const [agentSummary, setAgentSummary] = useState('');
  const [agentThinking, setAgentThinking] = useState('');
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [isAgentRequestPending, setIsAgentRequestPending] = useState(false);
  const [xiaozhiMessage, setXiaozhiMessage] = useState('你好呀！我是小智，你的数智课堂AI老师。有什么想学的3D模型或知识吗？');
  const [xiaozhiState, setXiaozhiState] = useState<XiaozhiVisualState>('idle');
  const [xiaozhiVoiceActive, setXiaozhiVoiceActive] = useState(false);
  const [voiceToggleRequest, setVoiceToggleRequest] = useState(0);
  const [forceVoiceToggle, setForceVoiceToggle] = useState(0);
  const [voiceActivateRequest, setVoiceActivateRequest] = useState<VoiceActivationRequest | null>(null);
  const [voiceDeactivateRequest, setVoiceDeactivateRequest] = useState(0);
  const [voiceListeningLocked, setVoiceListeningLocked] = useState(false);
  const [globalSpeechActive, setGlobalSpeechActive] = useState(isXiaozhiSpeechActive);
  const [isXiaozhiSpeaking, setIsXiaozhiSpeaking] = useState(false);
  const [lastFinalVoiceText, setLastFinalVoiceText] = useState('');
  const [followUpQuestion, setFollowUpQuestion] = useState<FollowUpQuestion | null>(null);
  const [followUpQuestionReady, setFollowUpQuestionReady] = useState(false);
  const [followUpRecognitionState, setFollowUpRecognitionState] = useState<VoiceRecognitionState>({ phase: 'idle' });
  const [isFollowUpPreparing, setIsFollowUpPreparing] = useState(false);
  const [expandedStructureImage, setExpandedStructureImage] = useState<string | null>(null);
  const [knowledgeContent, setKnowledgeContent] = useState('');
  const [isKnowledgeStreaming, setIsKnowledgeStreaming] = useState(false);
  const [isKnowledgeNarrating, setIsKnowledgeNarrating] = useState(false);
  const [knowledgeNarrationCharIndex, setKnowledgeNarrationCharIndex] = useState<number | null>(null);
  const [handNearStructureImage, setHandNearStructureImage] = useState(false);
  const [isHandExpanded, setIsHandExpanded] = useState(false);
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number; percent: number } | null>(null);
  const [modelLoadError, setModelLoadError] = useState<{ title: string; detail: string } | null>(null);
  const [quizMode, setQuizMode] = useState(false);
  const [quizSubjectFilter, setQuizSubjectFilter] = useState<string | undefined>(undefined);
  const [wrongBookOpen, setWrongBookOpen] = useState(false);
  const quizButtonRef = useRef<HTMLButtonElement>(null);
  const [handNearQuizButton, setHandNearQuizButton] = useState(false);
  const structureImageRef = useRef<HTMLButtonElement>(null);
  const hasAutoOpenedCameraRef = useRef(false);
  const knowledgeSpeechStreamRef = useRef<XiaozhiSpeechSession | null>(null);
  const knowledgeSpeechClosedRef = useRef(false);
  const knowledgeSpeechSessionRef = useRef(0);
  const knowledgeNarrationEpochRef = useRef(0);
  const knowledgeNarrationPlaybackEndedRef = useRef(false);
  const knowledgeNarrationTextRef = useRef('');
  const knowledgeNarrationGenerationDoneRef = useRef(false);
  const knowledgeNarrationErrorRef = useRef(false);
  const interactionAbortRef = useRef<AbortController | null>(null);
  const interactionEpochRef = useRef(0);
  const voiceRequestStartedAtRef = useRef(0);
  const modelReadyAtRef = useRef(0);
  const followUpSpeechEpochRef = useRef(0);
  const followUpTimelineIdRef = useRef<string | null>(null);
  const pendingKnowledgeNarrationRef = useRef<PendingKnowledgeNarration | null>(null);
  const onKnowledgeNarrationCompleteRef = useRef<(() => void) | null>(null);
  const answeredFollowUpQuestionIdRef = useRef<string | null>(null);
  const voiceConversationLoopRef = useRef(false);
  const voiceTurnRef = useRef(0);
  const completedVoiceTurnRef = useRef<number | null>(null);
  const voiceResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceActivationSequenceRef = useRef(0);
  const globalSpeechActiveRef = useRef(isXiaozhiSpeechActive());
  const voiceWorkBlockedRef = useRef(false);
  const pendingModelActivityRef = useRef<PendingModelActivity | null>(null);
  const pendingTeachingModelLoadRef = useRef<PendingTeachingModelLoad | null>(null);
  const activeContentRef = useRef(activeContent);
  const currentTeachingModelIdRef = useRef<TeachingModelId | null>(null);
  const modelUrlRef = useRef<string | null>(null);
  const loadedModelUrlRef = useRef<string | null>(null);
  const failedModelUrlRef = useRef<string | null>(null);
  const activeModelLoadRevisionRef = useRef(0);
  const modelStructureImage = activeContent === 'model' && modelUrl
    ? STRUCTURE_IMAGE_BY_MODEL[modelUrl]
    : undefined;
  const currentTeachingModelId: TeachingModelId | null = activeContent === 'biodigital'
    ? 'biodigital_heart'
    : modelUrl
      ? MODEL_ID_BY_URL[modelUrl] || null
      : null;
  activeContentRef.current = activeContent;
  currentTeachingModelIdRef.current = currentTeachingModelId;
  modelUrlRef.current = modelUrl;
  const voiceWorkBlocked = isAgentRequestPending
    || isFollowUpPreparing
    || isXiaozhiSpeaking
    || isVoiceInputLockedByAssistantState(xiaozhiState);
  voiceWorkBlockedRef.current = voiceWorkBlocked;
  const voiceInputDisabled = voiceWorkBlocked || voiceListeningLocked || globalSpeechActive;
  const knowledgePresentationActive = activeContent === 'model'
    && Boolean(modelUrl)
    && !quizMode
    && !followUpQuestion
    && Boolean(isKnowledgeStreaming || knowledgeContent);
  const showKnowledgePanel = knowledgePresentationActive;
  const activeModelProfile = activeContent === 'model' && activeLocalModelId === null
    ? getModelInfoProfile(activeModelSeedKey)
    : null;

  const detailPanelVisible = detailPanelOpen
    && !quizMode
    && !followUpQuestion
    && !isStageFullscreen
    && !isStageAppFullscreen;

  useEffect(() => {
    try {
      window.localStorage.setItem(`${SIDEBAR_TAB_STORAGE_PREFIX}:${currentUser.id}`, sidebarTab);
    } catch {
      // UI preferences are non-critical when storage is unavailable.
    }
  }, [currentUser.id, sidebarTab]);

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 899px)');
    const collapseForMobile = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setIsSidebarCollapsed(true);
    };
    const collapseOnResize = () => {
      if (window.innerWidth < 900) setIsSidebarCollapsed(true);
    };
    collapseForMobile(mobileQuery);
    mobileQuery.addEventListener('change', collapseForMobile);
    window.addEventListener('resize', collapseOnResize);
    return () => {
      mobileQuery.removeEventListener('change', collapseForMobile);
      window.removeEventListener('resize', collapseOnResize);
    };
  }, []);

  useEffect(() => {
    if (!showKnowledgePanel) return;
    setDetailPanelOpen(true);
    setDetailPanelTab('narration');
  }, [showKnowledgePanel]);

  useEffect(() => {
    let cancelled = false;
    openLearningSession()
      .then(({ session, settings }) => {
        if (cancelled) return;
        setLearningSessionId(session?.id || null);
        setMemorySettings(settings);
      })
      .catch((error) => console.warn('[Learning memory] Session unavailable:', error));
    return () => { cancelled = true; };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    const refreshSystemVoices = () => setSystemVoices(window.speechSynthesis?.getVoices?.() || []);
    refreshSystemVoices();
    window.speechSynthesis?.addEventListener?.('voiceschanged', refreshSystemVoices);
    fetch('/api/voice/preferences')
      .then(async (response) => {
        if (!response.ok) throw new Error('无法读取声音设置');
        return response.json();
      })
      .then(({ preference, provider }) => {
        if (cancelled) return;
        const next = { mode: preference.mode === 'volcengine' ? 'volcengine' : 'system', systemVoiceUri: preference.systemVoiceUri || '', providerVoiceId: preference.providerVoiceId || '' } as VoicePreference;
        setVoicePreference(next);
        setXiaozhiVoicePreference(next);
        setProviderVoices(Array.isArray(provider?.voices) ? provider.voices : []);
        setIsProviderVoiceAvailable(Boolean(provider?.available));
      })
      .catch((error) => console.warn('[Voice] preferences unavailable:', error));
    return () => { cancelled = true; window.speechSynthesis?.removeEventListener?.('voiceschanged', refreshSystemVoices); };
  }, [currentUser.id]);

  const beginVoiceTurn = useCallback(() => {
    voiceTurnRef.current += 1;
    completedVoiceTurnRef.current = null;
    if (voiceResumeTimerRef.current) {
      clearTimeout(voiceResumeTimerRef.current);
      voiceResumeTimerRef.current = null;
    }
    setVoiceListeningLocked(true);
    return voiceTurnRef.current;
  }, []);

  const requestVoiceActivation = useCallback((scope: VoiceActivationRequest['scope'], questionId?: string) => {
    voiceActivationSequenceRef.current += 1;
    setVoiceActivateRequest({ id: voiceActivationSequenceRef.current, scope, questionId });
  }, []);

  const requestVoiceDeactivation = useCallback(() => {
    setVoiceDeactivateRequest((current) => current + 1);
  }, []);

  const scheduleVoiceResume = useCallback((voiceTurn: number, delayMs = 1_000) => {
    if (voiceTurn !== voiceTurnRef.current
      || completedVoiceTurnRef.current !== voiceTurn
      || globalSpeechActiveRef.current
      || voiceWorkBlockedRef.current) return;
    if (voiceResumeTimerRef.current) clearTimeout(voiceResumeTimerRef.current);
    voiceResumeTimerRef.current = setTimeout(() => {
      if (voiceTurn !== voiceTurnRef.current
        || completedVoiceTurnRef.current !== voiceTurn
        || globalSpeechActiveRef.current
        || voiceWorkBlockedRef.current) return;
      voiceResumeTimerRef.current = null;
      completedVoiceTurnRef.current = null;
      setVoiceListeningLocked(false);
      if (voiceConversationLoopRef.current) {
        requestVoiceActivation('continuous');
      }
    }, delayMs);
  }, [requestVoiceActivation]);

  const finishVoiceTurn = useCallback((voiceTurn: number) => {
    if (voiceTurn !== voiceTurnRef.current) return;
    completedVoiceTurnRef.current = voiceTurn;
    scheduleVoiceResume(voiceTurn);
  }, [scheduleVoiceResume]);

  const cancelVoiceTurn = useCallback(() => {
    voiceTurnRef.current += 1;
    completedVoiceTurnRef.current = null;
    if (voiceResumeTimerRef.current) {
      clearTimeout(voiceResumeTimerRef.current);
      voiceResumeTimerRef.current = null;
    }
    setVoiceListeningLocked(false);
  }, []);

  useEffect(() => subscribeXiaozhiSpeechActivity((active) => {
    globalSpeechActiveRef.current = active;
    setGlobalSpeechActive(active);
    if (!active && knowledgeNarrationPlaybackEndedRef.current) {
      knowledgeNarrationPlaybackEndedRef.current = false;
      setIsKnowledgeNarrating(false);
    }
    if (!active && completedVoiceTurnRef.current !== null) {
      scheduleVoiceResume(completedVoiceTurnRef.current);
    } else if (active && voiceResumeTimerRef.current) {
      clearTimeout(voiceResumeTimerRef.current);
      voiceResumeTimerRef.current = null;
    }
  }), [scheduleVoiceResume]);

  useEffect(() => {
    if (!voiceWorkBlocked && completedVoiceTurnRef.current !== null) {
      scheduleVoiceResume(completedVoiceTurnRef.current);
    }
  }, [scheduleVoiceResume, voiceWorkBlocked]);

  useEffect(() => () => {
    if (voiceResumeTimerRef.current) clearTimeout(voiceResumeTimerRef.current);
  }, []);

  const resetKnowledgeSpeech = useCallback(() => {
    knowledgeNarrationEpochRef.current += 1;
    knowledgeNarrationPlaybackEndedRef.current = false;
    knowledgeNarrationTextRef.current = '';
    knowledgeNarrationGenerationDoneRef.current = false;
    knowledgeNarrationErrorRef.current = false;
    onKnowledgeNarrationCompleteRef.current = null;
    knowledgeSpeechStreamRef.current?.stop();
    knowledgeSpeechStreamRef.current = null;
    setIsXiaozhiSpeaking(false);
    setIsKnowledgeNarrating(false);
    setKnowledgeNarrationCharIndex(null);
  }, []);

  const reportVoicePlaybackError = useCallback((scope: string, error: Error) => {
    console.warn(`[Voice] ${scope} browser speech unavailable:`, error);
    setIsXiaozhiSpeaking(false);
  }, []);

  const saveVoicePreference = useCallback(async () => {
    setIsSavingVoice(true); setVoiceMessage('');
    try {
      const response = await fetch('/api/voice/preferences', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(voicePreference),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || '声音设置保存失败');
      const next = { mode: data.preference.mode, systemVoiceUri: data.preference.systemVoiceUri || '', providerVoiceId: data.preference.providerVoiceId || '' } as VoicePreference;
      setVoicePreference(next); setXiaozhiVoicePreference(next); setVoiceMessage('声音设置已保存');
    } catch (error) { setVoiceMessage(error instanceof Error ? error.message : '声音设置保存失败'); }
    finally { setIsSavingVoice(false); }
  }, [voicePreference]);

  const enqueueKnowledgeSpeech = useCallback((text: string) => {
    if (knowledgeSpeechClosedRef.current || knowledgeNarrationErrorRef.current) return;
    let speechSession = knowledgeSpeechStreamRef.current;
    if (!speechSession) {
      const voiceTurn = beginVoiceTurn();
      const narrationEpoch = ++knowledgeNarrationEpochRef.current;
      knowledgeNarrationPlaybackEndedRef.current = false;
      speechSession = createXiaozhiSpeechSession({
        onStart: () => {
          if (knowledgeNarrationEpochRef.current !== narrationEpoch) return;
          setIsXiaozhiSpeaking(true);
          setIsKnowledgeNarrating(true);
          setKnowledgeNarrationCharIndex(0);
          setXiaozhiState('explaining');
          setAiAnalysis('正在朗读知识讲解...');
        },
        onProgress: ({ charIndex }) => {
          if (knowledgeNarrationEpochRef.current !== narrationEpoch) return;
          setKnowledgeNarrationCharIndex(Math.min(Math.max(0, charIndex), Math.max(0, knowledgeNarrationTextRef.current.length - 1)));
        },
        onEnd: () => {
          if (knowledgeNarrationEpochRef.current !== narrationEpoch) return;
          knowledgeSpeechStreamRef.current = null;
          setIsXiaozhiSpeaking(false);
          setKnowledgeNarrationCharIndex(null);
          setXiaozhiState((current) => current === 'explaining' ? 'idle' : current);
          knowledgeNarrationPlaybackEndedRef.current = true;
          if (!globalSpeechActiveRef.current) {
            knowledgeNarrationPlaybackEndedRef.current = false;
            setIsKnowledgeNarrating(false);
          }
          finishVoiceTurn(voiceTurn);
          if (knowledgeNarrationGenerationDoneRef.current) {
            const cb = onKnowledgeNarrationCompleteRef.current;
            onKnowledgeNarrationCompleteRef.current = null;
            cb?.();
          }
        },
        onError: (error) => {
          if (knowledgeNarrationEpochRef.current !== narrationEpoch) return;
          knowledgeSpeechStreamRef.current = null;
          knowledgeNarrationErrorRef.current = true;
          knowledgeNarrationPlaybackEndedRef.current = true;
          setKnowledgeNarrationCharIndex(null);
          reportVoicePlaybackError('Knowledge', error);
          if (knowledgeNarrationGenerationDoneRef.current) {
            const cb = onKnowledgeNarrationCompleteRef.current;
            onKnowledgeNarrationCompleteRef.current = null;
            cb?.();
          }
        },
      });
      knowledgeSpeechStreamRef.current = speechSession;
    }
    speechSession.push(text);
  }, [beginVoiceTurn, finishVoiceTurn, reportVoicePlaybackError]);

  const flushKnowledgeSpeech = useCallback(() => {
    knowledgeSpeechStreamRef.current?.flush();
  }, []);

  const closeKnowledgePanel = useCallback(() => {
    const voiceTurn = voiceTurnRef.current;
    const hasKnowledgeSession = Boolean(knowledgeSpeechStreamRef.current);
    const voiceTurnAlreadyCompleted = completedVoiceTurnRef.current === voiceTurn;
    const shouldFinishVoiceTurn = shouldFinishVoiceTurnAfterKnowledgeClose(
      hasKnowledgeSession,
      globalSpeechActiveRef.current,
      voiceTurnAlreadyCompleted,
    );

    knowledgeSpeechClosedRef.current = true;
    pendingKnowledgeNarrationRef.current = null;
    setKnowledgeContent('');
    setIsKnowledgeStreaming(false);
    resetKnowledgeSpeech();
    setXiaozhiState((current) => getAssistantStateAfterKnowledgeClose(current));
    setAiAnalysis('知识讲解已关闭，语音输入即将恢复。');
    setFollowUpQuestion(null);
    setFollowUpQuestionReady(false);
    setIsFollowUpPreparing(false);
    setIsAgentRunning(false);
    setIsAgentRequestPending(false);
    setVoiceListeningLocked(false);
    setAgentTimeline([]);
    setAgentStatuses(AGENT_STATUS_IDLE);
    setXiaozhiMessage('');

    if (shouldFinishVoiceTurn) {
      finishVoiceTurn(voiceTurn);
    }
  }, [finishVoiceTurn, resetKnowledgeSpeech]);

  const letXiaozhiSpeak = useCallback((
    text: string,
    nextState: XiaozhiVisualState = 'explaining',
    onPlaybackEnd?: () => void,
  ) => {
    const message = text.trim();
    if (!message) {
      onPlaybackEnd?.();
      return Promise.resolve();
    }
    const voiceTurn = beginVoiceTurn();
    setXiaozhiMessage(message);
    setXiaozhiState(nextState);
    return speakXiaozhi(message, {
      onStart: () => {
        setIsXiaozhiSpeaking(true);
        if (voiceRequestStartedAtRef.current > 0) {
          const now = performance.now();
          console.info(
            `[Voice latency] model=${Math.round(modelReadyAtRef.current - voiceRequestStartedAtRef.current)}ms `
            + `tts-first=${Math.round(now - modelReadyAtRef.current)}ms `
            + `total=${Math.round(now - voiceRequestStartedAtRef.current)}ms`,
          );
          voiceRequestStartedAtRef.current = 0;
          modelReadyAtRef.current = 0;
        }
      },
      onEnd: () => {
        setIsXiaozhiSpeaking(false);
        setXiaozhiState((current) => current === nextState ? 'idle' : current);
        finishVoiceTurn(voiceTurn);
        onPlaybackEnd?.();
      },
      onError: (error) => reportVoicePlaybackError('Response', error),
    });
  }, [beginVoiceTurn, finishVoiceTurn, reportVoicePlaybackError]);

  // Refs
  const initialLocalModelLoadedRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const controlRef = useRef<ControlRefs>({
    rotationVelocity: { x: 0, y: 0 },
    rotationGestureActive: false,
    rotationLocked: false,
    voiceRotationActive: false,
    zoomSpeed: 0,
    panPosition: { x: 0, y: 0 },
    isDragging: false,
    handLandmarks: { left: null, right: null },
    interactionHandLandmarks: null,
    handNDCPosition: null,
    interactionSettings: { zoomSpeed: 0.8, rotationSpeed: 5.0 },
    agentDisassembly: {
      enabled: false,
      strength: 0,
      spacing: 1.1,
      avoidOverlap: true,
      actionId: 0,
      label: ''
    }
  });

  useEffect(() => {
    if (!playIntro) {
      setIntroReady(true);
      setStreamedInstruction(INTRO_INSTRUCTION);
      return;
    }

    setIntroReady(false);
    setStreamedInstruction('');

    let streamInterval: number | undefined;
    const readyTimer = window.setTimeout(() => setIntroReady(true), 2000);
    const streamStartTimer = window.setTimeout(() => {
      let index = 0;
      streamInterval = window.setInterval(() => {
        index += 1;
        setStreamedInstruction(INTRO_INSTRUCTION.slice(0, index));
        if (index >= INTRO_INSTRUCTION.length && streamInterval) {
          window.clearInterval(streamInterval);
        }
      }, 58);
    }, 2100);

    return () => {
      window.clearTimeout(readyTimer);
      window.clearTimeout(streamStartTimer);
      if (streamInterval) window.clearInterval(streamInterval);
    };
  }, [playIntro]);

  useEffect(() => {
    if (expandedStructureImage && expandedStructureImage !== modelStructureImage) {
      setExpandedStructureImage(null);
    }
  }, [expandedStructureImage, modelStructureImage]);

  // Hand proximity: auto-expand structure image when virtual hand is near
  useEffect(() => {
    if (!modelStructureImage || !cameraActive) return;

    const checkProximity = () => {
      const handLm = controlRef.current.interactionHandLandmarks;
      if (!handLm || handLm.length < 9) {
        setHandNearStructureImage(false);
        return;
      }
      // Use index finger tip (landmark 8)
      const indexTip = handLm[8];
      if (!indexTip) {
        setHandNearStructureImage(false);
        return;
      }

      const stageEl = stageRef.current;
      if (!stageEl) {
        setHandNearStructureImage(false);
        return;
      }

      // Convert normalized [0,1] camera coordinates to stage-relative viewport pixels.
      // In fullscreen the stage fills the viewport; outside fullscreen it is offset by the app chrome/sidebar.
      const stageRect = stageEl.getBoundingClientRect();
      const screenX = stageRect.left + (1 - indexTip.x) * stageRect.width;
      const screenY = stageRect.top + indexTip.y * stageRect.height;

      const imgEl = structureImageRef.current;
      if (!imgEl) {
        setHandNearStructureImage(false);
        return;
      }

      const rect = imgEl.getBoundingClientRect();
      const margin = 2;
      const isNear = (
        screenX >= rect.left - margin &&
        screenX <= rect.right + margin &&
        screenY >= rect.top - margin &&
        screenY <= rect.bottom + margin
      );

      setHandNearStructureImage(isNear);
    };

    const intervalId = setInterval(checkProximity, 100);
    return () => clearInterval(intervalId);
  }, [modelStructureImage, cameraActive, controlRef]);

  // Sync hand proximity to image expansion
  useEffect(() => {
    if (handNearStructureImage && modelStructureImage) {
      setExpandedStructureImage(modelStructureImage);
      setIsHandExpanded(true);
    } else if (!handNearStructureImage && isHandExpanded) {
      setExpandedStructureImage(null);
      setIsHandExpanded(false);
    }
  }, [handNearStructureImage, modelStructureImage, isHandExpanded]);

  // Hand proximity: trigger quiz mode button loading
  useEffect(() => {
    if (!cameraActive || quizMode || !modelUrl) {
      setHandNearQuizButton(false);
      return;
    }

    const checkProximity = () => {
      const handLm = controlRef.current.interactionHandLandmarks;
      if (!handLm || handLm.length < 9) {
        setHandNearQuizButton(false);
        return;
      }
      const indexTip = handLm[8];
      if (!indexTip) {
        setHandNearQuizButton(false);
        return;
      }

      const stageEl = stageRef.current;
      if (!stageEl) {
        setHandNearQuizButton(false);
        return;
      }

      const stageRect = stageEl.getBoundingClientRect();
      const screenX = stageRect.left + (1 - indexTip.x) * stageRect.width;
      const screenY = stageRect.top + indexTip.y * stageRect.height;

      const btnEl = quizButtonRef.current;
      if (!btnEl) {
        setHandNearQuizButton(false);
        return;
      }

      const rect = btnEl.getBoundingClientRect();
      const margin = 2;
      const isNear = (
        screenX >= rect.left - margin &&
        screenX <= rect.right + margin &&
        screenY >= rect.top - margin &&
        screenY <= rect.bottom + margin
      );

      setHandNearQuizButton(isNear);
    };

    const intervalId = setInterval(checkProximity, 100);
    return () => clearInterval(intervalId);
  }, [cameraActive, controlRef, quizMode, modelUrl]);

  // Loading progress timer for quiz button
  const quizProgressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let animFrame: number;
    let startTime: number | null = null;
    const duration = 2000;

    if (handNearQuizButton) {
      const animate = (timestamp: number) => {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        let progress = (elapsed / duration) * 100;

        if (progress >= 100) {
          progress = 100;
          if (quizProgressRef.current) {
            quizProgressRef.current.style.width = '100%';
          }
          setQuizSubjectFilter(modelUrl!);
          setQuizMode(true);
          setHandNearQuizButton(false);
        } else {
          if (quizProgressRef.current) {
            quizProgressRef.current.style.width = `${progress}%`;
          }
          animFrame = requestAnimationFrame(animate);
        }
      };
      animFrame = requestAnimationFrame(animate);
      
      return () => {
        cancelAnimationFrame(animFrame);
        if (quizProgressRef.current) {
            quizProgressRef.current.style.width = '0%';
        }
      };
    } else {
      if (quizProgressRef.current) {
          quizProgressRef.current.style.width = '0%';
      }
    }
  }, [handNearQuizButton, modelUrl]);

  const resetControls = () => {
    const nextActionId = (controlRef.current.agentDisassembly?.actionId ?? 0) + 1;
    controlRef.current = {
      rotationVelocity: { x: 0, y: 0 },
      rotationGestureActive: false,
      rotationLocked: controlRef.current.rotationLocked,
      voiceRotationActive: false,
      zoomSpeed: 0,
      panPosition: { x: 0, y: 0 },
      isDragging: false,
      handLandmarks: { left: null, right: null },
      interactionHandLandmarks: null,
      handNDCPosition: null,
      interactionSettings: {
        zoomSpeed: zoomSpeedMultiplier,
        rotationSpeed: rotationSpeedMultiplier,
      },
      agentDisassembly: {
        enabled: false,
        strength: 0,
        spacing: 1.1,
        avoidOverlap: true,
        actionId: nextActionId,
        label: ''
      }
    };
  };

  const revokeObjectUrls = () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
  };

  useEffect(() => revokeObjectUrls, []);

  useEffect(() => () => stopXiaozhiSpeech(), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listLocalModels(currentUser.id), listHiddenStaticModelIds(currentUser.id)])
      .then(([models, hiddenIds]) => {
        if (!cancelled) {
          setLocalModels(models);
          setHiddenStaticModelIds(hiddenIds);
          setLocalLibraryError('');
        }
      })
      .catch(() => {
        if (!cancelled) setLocalLibraryError('无法读取浏览器本地模型库');
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser.id]);

  useEffect(() => {
    let cancelled = false;
    setIsResourceLibraryLoading(true);
    fetchResourceLibrary()
      .then((tags) => {
        if (cancelled) return;
        const visibleTags = tags.filter((tag) => !HIDDEN_RESOURCE_TAG_NAMES.has(tag.name));
        setResourceTags(visibleTags);
        setResourceLibraryError('');
        setExpandedCategories((current) => {
          const next = new Set(current);
          visibleTags.forEach((tag) => next.add(resourceCategoryKey(tag.id)));
          return next;
        });
      })
      .catch((error) => {
        if (!cancelled) {
          setResourceLibraryError(error instanceof Error ? error.message : '学科资源库加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setIsResourceLibraryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 低优先级预加载优化版心脏模型
  useEffect(() => {
    const prefetch = async () => {
      try {
        await fetch(BUILT_IN_MODELS.heart, {
          cache: 'force-cache',
          priority: 'low' as RequestPriority,
        });
      } catch {
        // 预加载失败不影响主流程
      }
    };
    const timer = setTimeout(prefetch, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      const isNativeFullscreen = document.fullscreenElement === stageRef.current;
      setIsStageFullscreen(isNativeFullscreen);
      if (isNativeFullscreen) setIsStageAppFullscreen(false);
    };

    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  const showModelStage = () => {
    setActiveContent('model');
  };

  const showBioDigitalStage = (source: ModelActivitySource = 'ai') => {
    const previousModel = activeContent === 'model' && modelUrl
      ? (fileName || modelUrl)
      : activeContent === 'biodigital'
        ? '心脏模型2'
        : undefined;
    if (previousModel !== '心脏模型2') {
      void logUserActivity({
        type: 'model.switch',
        payload: {
          ...(previousModel ? { fromModel: previousModel } : {}),
          toModel: '心脏模型2',
          source,
        },
      });
    }
    setActiveContent('biodigital');
    activeModelLoadRevisionRef.current += 1;
    loadedModelUrlRef.current = null;
    failedModelUrlRef.current = null;
    setActiveModelSeedKey(null);
    setDetailPanelOpen(true);
    setDetailPanelTab('info');
    setCameraActive(false);
    resetControls();
    setAiAnalysis('正在加载心脏模型2：URL 交互展示页面。');
  };

  const clearLocalModel = () => {
    pendingModelActivityRef.current = null;
    loadedModelUrlRef.current = null;
    failedModelUrlRef.current = null;
    activeModelLoadRevisionRef.current += 1;
    revokeObjectUrls();
    setModelUrl(null);
    setModelType('glb');
    setModelAssetUrls({});
    setFileName('');
    setLoadProgress(null);
    setModelLoadError(null);
    setActiveLocalModelId(null);
    setActiveModelSeedKey(null);
    setDetailPanelOpen(window.innerWidth >= 900);
    setDetailPanelTab('info');
    resetControls();
  };

  const enterStageFullscreen = async (): Promise<'native' | 'app'> => {
    if (document.fullscreenElement === stageRef.current) return 'native';
    const stage = stageRef.current;
    if (!stage) throw new Error('展示区尚未就绪');

    try {
      await stage.requestFullscreen();
      return 'native';
    } catch (error) {
      // Voice recognition callbacks do not retain the transient user activation
      // required by the browser Fullscreen API. Keep voice commands reliable by
      // switching to the equivalent in-app immersive presentation instead.
      console.warn('Native fullscreen unavailable; using app fullscreen:', error);
      setIsStageAppFullscreen(true);
      return 'app';
    }
  };

  const exitStageFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    setIsStageAppFullscreen(false);
  };

  const toggleStageFullscreen = async () => {
    try {
      if (document.fullscreenElement || isStageAppFullscreen) {
        await exitStageFullscreen();
      } else {
        await enterStageFullscreen();
      }
    } catch (error) {
      console.error('Fullscreen failed:', error);
      setAiAnalysis('展示区全屏切换失败，请稍后重试。');
    }
  };

  const handleModelUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    const modelFile = files.find((file) => /\.(glb|gltf|fbx)$/i.test(file.name));
    event.target.value = '';
    if (!modelFile) {
      setLocalLibraryError('请选择 GLB、GLTF 或 FBX 模型文件');
      return;
    }

    try {
      setIsSavingLocalModel(true);
      setLocalLibraryError('');
      setAiAnalysis(`正在保存到我的模型：${modelFile.name}`);
      const record = await saveUploadedModel({ ownerId: currentUser.id, files });
      const updatedModels = await listLocalModels(currentUser.id);
      setLocalModels(updatedModels);
      await openLocalModel(record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '模型保存失败';
      setLocalLibraryError(message);
      setAiAnalysis(message);
    } finally {
      setIsSavingLocalModel(false);
    }
  };

  const loadDemoModel = (
    url: string,
    name: string,
    type: ModelType = 'glb',
    assets: Record<string, string> = {},
    source: ModelActivitySource = 'manual',
    seedKey?: string | null,
    forceReload = false,
  ) => {
    const shouldReload = forceReload || failedModelUrlRef.current === url;
    if (source !== 'ai') {
      cancelPendingTeachingModelLoad(new DOMException('Interaction aborted', 'AbortError'));
      interactionAbortRef.current?.abort();
      interactionAbortRef.current = null;
    }
    if (!hasAutoOpenedCameraRef.current) {
      hasAutoOpenedCameraRef.current = true;
      setCameraActive(true);
    }
    showModelStage();
    if (/^https?:\/\//i.test(url)) {
      pendingModelActivityRef.current = null;
      setAiAnalysis('演示模型已切换为离线模式，请直接导入本地 GLB/GLTF/FBX 模型。');
      return;
    }

    const previousModel = activeContent === 'model' && modelUrl
      ? (fileName || modelUrl)
      : activeContent === 'biodigital'
        ? '心脏模型2'
        : undefined;
    const resolvedSeedKey = seedKey || getModelSeedKeyByUrl(url);
    if (!shouldReload && activeContent === 'model' && modelUrl === url && activeLocalModelId === null) {
      pendingModelActivityRef.current = null;
      setActiveModelSeedKey(resolvedSeedKey);
      setDetailPanelOpen(true);
      setDetailPanelTab('info');
      setAiAnalysis(`正在演示: ${name}`);
      return;
    }
    pendingModelActivityRef.current = {
      modelUrl: url,
      ...(previousModel ? { fromModel: previousModel } : {}),
      toModel: name,
      source,
    };
    loadedModelUrlRef.current = null;
    failedModelUrlRef.current = null;
    revokeObjectUrls();
    const normalizedAssets = Object.fromEntries(
      Object.entries(assets).flatMap(([assetName, assetUrl]) => [
        [assetName, assetUrl],
        [assetName.toLowerCase(), assetUrl],
      ]),
    );
    const nextLoadRevision = activeModelLoadRevisionRef.current + 1;
    activeModelLoadRevisionRef.current = nextLoadRevision;
    setModelLoadRevision(nextLoadRevision);
    setModelUrl(url);
    setModelType(type);
    setModelAssetUrls(normalizedAssets);
    setFileName(name);
    setLoadProgress(null);
    setModelLoadError(null);
    setActiveLocalModelId(null);
    setActiveModelSeedKey(resolvedSeedKey);
    setDetailPanelOpen(true);
    setDetailPanelTab('info');
    resetControls();
    setAiAnalysis(`正在演示: ${name}`);
  };

  const openLocalModel = async (modelId: string) => {
    try {
      setLocalLibraryError('');
      const record = await getLocalModel(modelId, currentUser.id);
      if (!record) throw new Error('这个模型已不在浏览器本地模型库中');
      if (activeContent === 'model' && activeLocalModelId === record.id) {
        setAiAnalysis(`已从我的模型加载：${record.name}`);
        return;
      }

      const previousModel = activeContent === 'model' && modelUrl
        ? (fileName || modelUrl)
        : activeContent === 'biodigital'
          ? '心脏模型2'
          : undefined;
      revokeObjectUrls();
      const url = URL.createObjectURL(record.blob);
      loadedModelUrlRef.current = null;
      failedModelUrlRef.current = null;
      const nextLoadRevision = activeModelLoadRevisionRef.current + 1;
      activeModelLoadRevisionRef.current = nextLoadRevision;
      setModelLoadRevision(nextLoadRevision);
      objectUrlsRef.current.push(url);
      const nextAssetUrls: Record<string, string> = {
        [record.name]: url,
        [record.name.toLowerCase()]: url,
      };
      (record.assets || []).forEach((asset) => {
        const assetUrl = URL.createObjectURL(asset.blob);
        objectUrlsRef.current.push(assetUrl);
        nextAssetUrls[asset.name] = assetUrl;
        nextAssetUrls[asset.name.toLowerCase()] = assetUrl;
      });
      showModelStage();
      pendingModelActivityRef.current = {
        modelUrl: url,
        ...(previousModel ? { fromModel: previousModel } : {}),
        toModel: record.name,
        source: 'local',
      };
      setModelUrl(url);
      setModelType(record.type);
      setModelAssetUrls(nextAssetUrls);
      setFileName(record.name);
      setLoadProgress(null);
      setModelLoadError(null);
      setActiveLocalModelId(record.id);
      setActiveModelSeedKey(null);
      setDetailPanelOpen(true);
      setDetailPanelTab('info');
      resetControls();
      if (!hasAutoOpenedCameraRef.current) {
        hasAutoOpenedCameraRef.current = true;
        setCameraActive(true);
      }
      setAiAnalysis(`已从我的模型加载：${record.name}`);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : '本地模型读取失败';
      setLocalLibraryError(message);
      setAiAnalysis(message);
    }
  };

  useEffect(() => {
    if (!initialLocalModelId || initialLocalModelLoadedRef.current === initialLocalModelId) return;
    initialLocalModelLoadedRef.current = initialLocalModelId;
    void openLocalModel(initialLocalModelId);
  }, [initialLocalModelId]);

  const loadHeartFallbackModel = () => {
    loadDemoModel(BUILT_IN_MODELS.heart, '心脏模型', 'glb', {}, 'fallback');
  };

  const settlePendingTeachingModelLoad = useCallback((modelUrl: string | null | undefined, error?: Error | DOMException) => {
    const pending = pendingTeachingModelLoadRef.current;
    if (!pending || !modelUrl || pending.modelUrl !== modelUrl) return;
    pendingTeachingModelLoadRef.current = null;
    window.clearTimeout(pending.timer);
    pending.abortHandler?.();
    if (error) pending.reject(error);
    else pending.resolve();
  }, []);

  const cancelPendingTeachingModelLoad = useCallback((error: Error | DOMException) => {
    const pending = pendingTeachingModelLoadRef.current;
    if (pending) settlePendingTeachingModelLoad(pending.modelUrl, error);
  }, [settlePendingTeachingModelLoad]);

  const handleModelLoadError = useCallback((modelUrl: string, loadRevision: number, error: { title: string; detail: string }) => {
    if (!isCurrentModelLoadEvent(modelUrl, modelUrlRef.current, loadRevision, activeModelLoadRevisionRef.current)) return;
    pendingModelActivityRef.current = null;
    if (loadedModelUrlRef.current === modelUrl) loadedModelUrlRef.current = null;
    failedModelUrlRef.current = modelUrl;
    setLoadProgress(null);
    setModelLoadError(error);
    setAiAnalysis(`${error.title}：${error.detail}`);
    const pending = pendingTeachingModelLoadRef.current;
    if (pending?.modelUrl === modelUrl) {
      settlePendingTeachingModelLoad(
        modelUrl,
        new TeachingModelLoadError(pending.modelId, modelUrl, `${error.title}：${error.detail}`),
      );
    }
  }, [settlePendingTeachingModelLoad]);

  const modelViewerLoadErrorHandler = useMemo(() => {
    const eventModelUrl = modelUrl;
    const eventLoadRevision = modelLoadRevision;
    return (error: { title: string; detail: string }) => {
      if (!eventModelUrl) return;
      handleModelLoadError(eventModelUrl, eventLoadRevision, error);
    };
  }, [handleModelLoadError, modelLoadRevision, modelUrl]);

  const loadTeachingModel = (modelId: TeachingModelId, source: ModelActivitySource = 'ai', signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Interaction aborted', 'AbortError'));
    }

    if (source !== 'ai') {
      cancelPendingTeachingModelLoad(new DOMException('Interaction aborted', 'AbortError'));
      interactionAbortRef.current?.abort();
      interactionAbortRef.current = null;
      stopXiaozhiSpeech();
      knowledgeSpeechClosedRef.current = true;
      knowledgeSpeechSessionRef.current += 1;
      resetKnowledgeSpeech();
      setIsAgentRunning(false);
      setIsAgentRequestPending(false);
      setIsFollowUpPreparing(false);
      setVoiceListeningLocked(false);
      setFollowUpQuestion(null);
      setFollowUpQuestionReady(false);
      setKnowledgeContent('');
      setIsKnowledgeStreaming(false);
      setAgentTimeline([]);
      setAgentStatuses(AGENT_STATUS_IDLE);
      setXiaozhiState('idle');
      setXiaozhiMessage('');
      setAgentThinking('');
      setAgentSummary('');
    }

    const targetModelUrl = MODEL_URL_BY_ID[modelId];
    const pendingLoad = pendingTeachingModelLoadRef.current;
    const loadAction = decideTeachingModelLoad({
      targetModelId: modelId,
      targetModelUrl,
      activeContent: activeContentRef.current,
      activeModelId: currentTeachingModelIdRef.current,
      activeModelUrl: modelUrlRef.current,
      loadedModelUrl: loadedModelUrlRef.current,
      failedModelUrl: failedModelUrlRef.current,
      pendingModelId: pendingLoad?.modelId,
      pendingModelUrl: pendingLoad?.modelUrl,
    });

    if (loadAction === 'ready') return Promise.resolve();
    if (source === 'ai' && loadAction === 'reuse' && pendingLoad) return pendingLoad.promise;

    if (pendingLoad) {
      cancelPendingTeachingModelLoad(new DOMException('Replaced by a newer model load', 'AbortError'));
    }

    currentTeachingModelIdRef.current = modelId;
    activeContentRef.current = modelId === 'biodigital_heart' ? 'biodigital' : 'model';
    modelUrlRef.current = targetModelUrl || null;

    if (modelId === 'biodigital_heart') {
      showBioDigitalStage(source);
      return Promise.resolve();
    }

    if (!targetModelUrl) return Promise.reject(new Error(`未找到模型 ${modelId} 的资源地址`));

    let resolveLoad!: () => void;
    let rejectLoad!: (error: Error | DOMException) => void;
    const loadPromise = new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    const pending: PendingTeachingModelLoad = {
      modelId,
      modelUrl: targetModelUrl,
      promise: loadPromise,
      resolve: resolveLoad,
      reject: rejectLoad,
      timer: window.setTimeout(() => {
        if (pendingTeachingModelLoadRef.current !== pending) return;
        failedModelUrlRef.current = targetModelUrl;
        settlePendingTeachingModelLoad(
          targetModelUrl,
          new TeachingModelLoadError(modelId, targetModelUrl, `${getTeachingModelName(modelId)}加载超时，请检查模型资源或网络连接`),
        );
      }, TEACHING_MODEL_LOAD_TIMEOUT_MS),
    };
    pendingTeachingModelLoadRef.current = pending;
    if (signal) {
      const onAbort = () => settlePendingTeachingModelLoad(targetModelUrl, new DOMException('Interaction aborted', 'AbortError'));
      pending.abortHandler = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
        return loadPromise;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (loadAction === 'wait') return loadPromise;
    const forceReload = loadAction === 'retry';

    switch (modelId) {
      case 'heart':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.heart, '心脏模型', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'hiv':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.hiv, 'HIV 病毒模型', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'diamond':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.diamond, '金刚石模型', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'diamond_unit_cell':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.diamondUnitCell, '金刚石晶胞', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'pubchem_6233':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.pubchem6233, '1,4-二氯甲基苯', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'nacl':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.nacl, 'NaCl 离子晶体', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'sio2':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.sio2, 'SiO₂ 二氧化硅网络', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'nitrobenzene':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.nitrobenzene, '硝基苯', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'brain':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.brain, '大脑模型', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'organ_heart':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organHeart, '心脏（解剖）', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'lungs':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organLungs, '肺', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'liver':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organLiver, '肝脏', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'kidneys':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organKidneys, '肾脏', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'eyeball':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organEyeball, '眼球', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'intestine':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organIntestine, '肠', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'pancreas':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organPancreas, '胰腺', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'skin':
        showModelStage();
        loadDemoModel(BUILT_IN_MODELS.organSkin, '皮肤', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'terrain':
        showModelStage();
        loadDemoModel('/models/terrain-topography.glb', '地形地貌', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
      case 'earth_layers':
      default:
        showModelStage();
        loadDemoModel('/models/earth-layers.glb', '地球内部结构', 'glb', {}, source, undefined, forceReload);
        return loadPromise;
    }
  };

  useEffect(() => () => {
    cancelPendingTeachingModelLoad(new DOMException('Component unmounted', 'AbortError'));
  }, [cancelPendingTeachingModelLoad]);

  const setTimelineStatus = (id: string, status: AgentTimelineItem['status']) => {
    setAgentTimeline((items) => items.map((item) => item.id === id ? { ...item, status } : item));
  };

  const appendTimeline = (item: AgentTimelineItem) => {
    setAgentTimeline((items) => [...items, item]);
  };

  const runAgentTool = async (call: AgentToolCall, signal?: AbortSignal, planModelId?: TeachingModelId): Promise<string> => {
    throwIfAborted(signal);
    const contextModelId = planModelId || currentTeachingModelIdRef.current || 'earth_layers';
    const contextModelUrl = MODEL_URL_BY_ID[contextModelId] || modelUrlRef.current;
    const timelineId = `${call.id}-${Date.now()}`;
    appendTimeline({
      id: timelineId,
      agent: 'executor',
      title: call.label,
      detail: `工具调用：${call.name}`,
      status: 'running',
    });

    try {
      switch (call.name) {
        case 'load_model': {
          const modelId = planModelId || (call.args.modelId || 'earth_layers') as TeachingModelId;
          await loadTeachingModel(modelId, 'ai', signal);
          throwIfAborted(signal);
          controlRef.current.zoomSpeed = -1.56;
          await sleep(900, signal);
          controlRef.current.zoomSpeed = 0;
          break;
        }
        case 'auto_rotate': {
          const speed = Number(call.args.speed ?? 0.96);
          const durationMs = Number(call.args.durationMs ?? 2200);
          if (controlRef.current.rotationLocked && speed !== 0) {
            setAiAnalysis('旋转已锁定，自动旋转指令已忽略。');
            break;
          }
          controlRef.current.rotationGestureActive = false;
          controlRef.current.rotationVelocity = { x: 0, y: speed };
          await sleep(Math.max(100, durationMs), signal);
          if (speed !== 0) {
            controlRef.current.rotationVelocity = { x: 0, y: 0 };
          }
          break;
        }
        case 'auto_zoom': {
          const direction = String(call.args.direction || 'in');
          const durationMs = Number(call.args.durationMs ?? 1200);
          controlRef.current.zoomSpeed = direction === 'out' ? -1.08 : 1.08;
          await sleep(Math.max(100, durationMs), signal);
          controlRef.current.zoomSpeed = 0;
          break;
        }
        case 'explode_model': {
          if (contextModelUrl?.includes('diamond.glb') || contextModelUrl?.includes('diamond-unit-cell')) {
            setAiAnalysis('金刚石结构模型为完整结构展示，不支持拆解。');
            break;
          }
          const disassemblyArgs = getAutonomousDisassemblyArgs(
            contextModelId,
            call.args,
          );
          // 解剖模型（心脏解剖/大脑/肺）沿用心脏的拆解参数
          const isHeartModel = contextModelId === 'heart' || isOneWayAnatomyModel(contextModelUrl, contextModelId);
          controlRef.current.agentDisassembly = {
            enabled: true,
            strength: Math.max(0, Math.min(1.4, Number(disassemblyArgs.strength ?? 0.95))),
            spacing: Math.max(isHeartModel ? 0.17 : 0.6, Number(disassemblyArgs.spacing ?? 1.15)),
            avoidOverlap: true,
            actionId: (controlRef.current.agentDisassembly?.actionId ?? 0) + 1,
            label: call.label,
          };
          await sleep(Number(call.args.durationMs ?? 1600), signal);
          break;
        }
        case 'reset_model_layout': {
          if (contextModelId === 'earth_layers' || contextModelUrl?.includes('earth-layers')) {
            setAiAnalysis('地球内部结构保持四层拆解展示，便于观众观察。');
          } else if (isOneWayAnatomyModel(contextModelUrl, contextModelId)) {
            // 单向拆解：解剖模型展开后不做部件归位
            setAiAnalysis('解剖模型为单向拆解展示，不做部件归位。');
          } else {
            controlRef.current.agentDisassembly = {
              enabled: false,
              strength: 0,
              spacing: 1.1,
              avoidOverlap: true,
              actionId: (controlRef.current.agentDisassembly?.actionId ?? 0) + 1,
              label: '恢复模型布局',
            };
          }
          await sleep(900, signal);
          break;
        }
        case 'enable_gesture':
          showModelStage();
          setCameraActive(true);
          setAiAnalysis('手势操纵已开启，请将手掌放在摄像头画面中央。');
          await sleep(300, signal);
          break;
        case 'disable_gesture':
          setCameraActive(false);
          controlRef.current.isDragging = false;
          controlRef.current.zoomSpeed = 0;
          controlRef.current.rotationGestureActive = false;
          controlRef.current.rotationVelocity = { x: 0, y: 0 };
          setAiAnalysis('手势操纵已关闭。');
          await sleep(300, signal);
          break;
        case 'enter_fullscreen': {
          if (!document.fullscreenElement && !isStageAppFullscreen) {
            const fullscreenMode = await enterStageFullscreen();
            setAiAnalysis(fullscreenMode === 'native'
              ? '已进入展示区全屏。'
              : '已进入沉浸式全屏展示。');
          } else {
            setAiAnalysis('展示区当前已是全屏。');
          }
          break;
        }
        case 'exit_fullscreen':
          if (document.fullscreenElement || isStageAppFullscreen) {
            await exitStageFullscreen();
            setAiAnalysis('已退出全屏，恢复小屏展示。');
          } else {
            setAiAnalysis('展示区当前已是小屏。');
          }
          break;
        case 'switch_sidebar': {
          const nextTab = call.args.tab === 'resource' ? 'resource' : 'agent';
          setSidebarTab(nextTab);
          setIsSidebarCollapsed(false);
          setAiAnalysis(nextTab === 'resource' ? '已切换到学科资源库。' : '已切换到多智能体平台。');
          await sleep(300, signal);
          break;
        }
        case 'set_teacher_log':
          setAiAnalysis(String(call.args.text || call.label));
          await sleep(250, signal);
          break;
        default:
          await sleep(200, signal);
      }

      setTimelineStatus(timelineId, 'done');
      return call.label;
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      console.error('Agent tool failed:', error);
      setTimelineStatus(timelineId, 'error');
      if (call.name === 'load_model') throw error;
      return `${call.label}失败`;
    }
  };

  const triggerFollowUpQuestion = async (
    modelIdOverride?: TeachingModelId,
    signal?: AbortSignal,
    interactionEpoch?: number,
    knowledgeNarrationAfterAnswer = '',
  ) => {
    if (isFollowUpPreparing) return;
    const modelIdForQuestion = modelIdOverride || currentTeachingModelId || 'earth_layers';
    const modelUrlForQuestion = MODEL_URL_BY_ID[modelIdForQuestion] || modelUrl || '/models/earth-layers.glb';

    pendingKnowledgeNarrationRef.current = null;
    answeredFollowUpQuestionIdRef.current = null;
    setIsFollowUpPreparing(true);
    setXiaozhiState('questioning');
    setAgentStatuses((current) => ({ ...current, questioner: 'thinking' }));
    setXiaozhiMessage('小智正在想一个轻松的小问题...');
    const questionerTimelineId = `questioner-${Date.now()}`;
    followUpTimelineIdRef.current = questionerTimelineId;
    appendTimeline({
      id: questionerTimelineId,
      agent: 'questioner',
      title: '生成课堂追问',
      detail: '根据当前模型和讲解内容生成追问题目。',
      status: 'running',
    });

    try {
      const question = await buildFollowUpQuestion({
        modelId: modelIdForQuestion,
        modelUrl: modelUrlForQuestion,
        modelName: getTeachingModelName(modelIdForQuestion),
        topic: fileName,
      }, signal);
      throwIfAborted(signal);
      if (interactionEpoch !== undefined && interactionEpochRef.current !== interactionEpoch) {
        setAgentStatuses((current) => ({ ...current, questioner: 'error' }));
        setAgentTimeline((items) => items.map((item) => item.id === questionerTimelineId
          ? { ...item, status: 'error', detail: '课堂追问生成已被新的任务中断。' }
          : item));
        return;
      }
      const speechEpoch = ++followUpSpeechEpochRef.current;
      setLastFinalVoiceText('');
      setFollowUpQuestionReady(false);
      setFollowUpRecognitionState({ phase: 'waiting', message: '小智正在朗读题目' });
      setFollowUpQuestion(question);
      const pendingNarration = knowledgeNarrationAfterAnswer.trim();
      pendingKnowledgeNarrationRef.current = pendingNarration
        ? { questionId: question.id, text: pendingNarration }
        : null;
      setAgentStatuses((current) => ({ ...current, questioner: 'running' }));
      setAgentTimeline((items) => items.map((item) => item.id === questionerTimelineId
        ? { ...item, detail: `等待作答：${question.question}` }
        : item));
      let followUpReadyTimer: ReturnType<typeof setTimeout> | null = null;
      const markFollowUpReady = () => {
        if (followUpSpeechEpochRef.current !== speechEpoch) return;
        if (followUpReadyTimer) { clearTimeout(followUpReadyTimer); followUpReadyTimer = null; }
        setLastFinalVoiceText('');
        setFollowUpRecognitionState({ phase: 'waiting', message: '正在准备语音识别' });
        setFollowUpQuestionReady(true);
      };
      followUpReadyTimer = setTimeout(() => {
        if (followUpSpeechEpochRef.current !== speechEpoch) return;
        markFollowUpReady();
      }, 15000);
      void letXiaozhiSpeak(
        `小挑战来啦！${question.question} A：${question.options[0]}。B：${question.options[1]}。`,
        'questioning',
        () => {
          if (followUpSpeechEpochRef.current !== speechEpoch) return;
          setTimeout(markFollowUpReady, 500);
        },
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        setAgentStatuses((current) => ({ ...current, questioner: 'error' }));
        setAgentTimeline((items) => items.map((item) => item.id === questionerTimelineId
          ? { ...item, status: 'error', detail: '课堂追问生成已中断。' }
          : item));
        return;
      }
      console.error('Follow-up question failed:', error);
      pendingKnowledgeNarrationRef.current = null;
      setAgentStatuses((current) => ({ ...current, questioner: 'error' }));
      setAgentTimeline((items) => items.map((item) => item.id === questionerTimelineId
        ? { ...item, status: 'error', detail: '课堂追问生成失败。' }
        : item));
      letXiaozhiSpeak(
        '小智刚刚出题时卡了一下，我们可以稍后再挑战。',
        'error',
      );
    } finally {
      setIsFollowUpPreparing(false);
    }
  };

  const handleAgentStart = async (request: string, signal?: AbortSignal, interactionEpoch?: number, sessionId?: number | null, modelOverride?: TeachingModelId | null) => {
    if (isAgentRunning) return;
    let ownedController: AbortController | null = null;
    if (!signal) {
      interactionAbortRef.current?.abort();
      ownedController = new AbortController();
      interactionAbortRef.current = ownedController;
      signal = ownedController.signal;
      interactionEpoch = ++interactionEpochRef.current;
    }
    const runEpoch = interactionEpoch ?? interactionEpochRef.current;
    throwIfAborted(signal);

    setSidebarTab('agent');
    setIsSidebarCollapsed(false);

    setIsAgentRunning(true);
    setXiaozhiState('planning');
    setXiaozhiMessage('收到，我先规划课堂演示路线。');
    knowledgeSpeechClosedRef.current = false;
    knowledgeSpeechSessionRef.current += 1;
    pendingKnowledgeNarrationRef.current = null;
    answeredFollowUpQuestionIdRef.current = null;
    resetKnowledgeSpeech();
    setKnowledgeContent('');
    setIsKnowledgeStreaming(false);
    setAgentThinking('');
    setAgentTimeline([]);
    setAgentSummary('');
    setAgentStatuses(makeAgentStatuses({ planner: 'thinking' }));
    setFollowUpQuestion(null);
    setFollowUpQuestionReady(false);
    setIsFollowUpPreparing(false);
    const executedLogs: string[] = [];

    try {
      const matchedModel = modelOverride || inferTeachingModel(request);
      const matchedModelName = getTeachingModelName(matchedModel);
      const initialThinking = `我正在理解教学需求，先识别关键词并匹配教具：当前判断适合使用“${matchedModelName}”。随后会生成演示步骤并调用工具。`;
      setAgentThinking(initialThinking);
      setAiAnalysis(initialThinking);

      appendTimeline({
        id: `planner-${Date.now()}`,
        agent: 'planner',
        title: `自动匹配${matchedModelName}`,
        detail: `教学需求：${request}`,
        status: 'running',
      });

      const plan = await buildTeachingPlan(request, signal, matchedModel);
      throwIfAborted(signal);
      setXiaozhiState('executing');
      setAgentThinking(`规划完成：已选择“${getTeachingModelName(plan.modelId)}”，准备执行 ${plan.steps.length} 个演示步骤。`);
      executedLogs.push(`生成${plan.steps.length}个演示步骤：${plan.topic}`);
      setAgentStatuses(makeAgentStatuses({ planner: 'done', executor: 'running' }));
      setAgentTimeline((items) => items.map((item) => item.agent === 'planner' ? { ...item, status: 'done', detail: `规划完成：${plan.topic}` } : item));
      setAiAnalysis(`规划完成：${plan.topic}`);

      for (const step of plan.steps) {
        appendTimeline({
          id: step.id,
          agent: 'executor',
          title: step.title,
          detail: step.narration,
          status: 'running',
        });
        setAiAnalysis(step.narration);
        executedLogs.push(step.title);

        for (const call of step.toolCalls) {
          const log = await runAgentTool(call, signal, plan.modelId);
          executedLogs.push(log);
        }

        setTimelineStatus(step.id, 'done');
      }

      // Stream knowledge text and start narration as soon as a natural speech segment is ready.
      setAgentStatuses(makeAgentStatuses({ planner: 'done', executor: 'done', evaluator: 'thinking' }));
      setXiaozhiState('explaining');
      setAgentThinking('知识讲解Agent正在生成关于该模型的教学内容...');
      setAiAnalysis('知识讲解Agent正在生成教学内容...');
      setKnowledgeContent('');
      knowledgeNarrationTextRef.current = '';
      knowledgeNarrationGenerationDoneRef.current = false;
      knowledgeNarrationErrorRef.current = false;
      setIsSidebarCollapsed(true);
      setIsKnowledgeStreaming(true);
      appendTimeline({
        id: `evaluator-${Date.now()}`,
        agent: 'evaluator',
        title: '生成知识讲解',
        detail: '根据模型和教学需求生成知识内容。',
        status: 'running',
      });

      const knowledgeSpeechSession = knowledgeSpeechSessionRef.current;
      let accumulatedKnowledge = '';
      const fullKnowledge = await buildKnowledgeExplanation(
        request,
        plan.modelId,
        (token: string) => {
          if (signal?.aborted || interactionEpochRef.current !== runEpoch || knowledgeSpeechClosedRef.current || knowledgeSpeechSessionRef.current !== knowledgeSpeechSession) return;
          accumulatedKnowledge += token;
          knowledgeNarrationTextRef.current = accumulatedKnowledge;
          setKnowledgeContent(accumulatedKnowledge);
          enqueueKnowledgeSpeech(token);
        },
        signal,
      );

      // The stream normally ends with the same text returned by the provider. If
      // a fallback supplies extra text, append only the missing suffix so it is
      // spoken once and remains part of the same narration session.
      if (fullKnowledge && fullKnowledge.startsWith(accumulatedKnowledge) && fullKnowledge.length > accumulatedKnowledge.length) {
        const missingKnowledge = fullKnowledge.slice(accumulatedKnowledge.length);
        accumulatedKnowledge = fullKnowledge;
        knowledgeNarrationTextRef.current = accumulatedKnowledge;
        setKnowledgeContent(accumulatedKnowledge);
        enqueueKnowledgeSpeech(missingKnowledge);
      } else if (fullKnowledge && !accumulatedKnowledge) {
        accumulatedKnowledge = fullKnowledge;
        knowledgeNarrationTextRef.current = accumulatedKnowledge;
        setKnowledgeContent(accumulatedKnowledge);
        enqueueKnowledgeSpeech(fullKnowledge);
      }

      const canNarrate = !signal?.aborted
        && interactionEpochRef.current === runEpoch
        && !knowledgeSpeechClosedRef.current
        && knowledgeSpeechSessionRef.current === knowledgeSpeechSession
        && fullKnowledge;
      if (canNarrate) {
        setKnowledgeContent(fullKnowledge);
        setAgentSummary(fullKnowledge);
        setAiAnalysis('正在朗读知识讲解...');
        if (sessionId) {
          void appendLearningMessage(sessionId, 'assistant', fullKnowledge, {
            kind: 'knowledge_explanation',
            modelId: plan.modelId,
          }).catch((error) => console.warn('[Learning memory] Explanation save failed:', error));
        }
      }
      setIsKnowledgeStreaming(false);
      knowledgeNarrationGenerationDoneRef.current = true;
      setAgentThinking('');
      setAgentStatuses(makeAgentStatuses({ planner: 'done', executor: 'done', evaluator: 'done' }));
      setAgentTimeline((items) => items.map((item) => item.agent === 'evaluator'
        ? { ...item, status: 'done', detail: canNarrate ? '正在朗读知识讲解' : '讲解内容已生成' }
        : item));
      throwIfAborted(signal);
      if (canNarrate && !knowledgeNarrationErrorRef.current && knowledgeSpeechStreamRef.current) {
        onKnowledgeNarrationCompleteRef.current = () => {
          onKnowledgeNarrationCompleteRef.current = null;
          if (signal?.aborted || interactionEpochRef.current !== runEpoch) return;
          void triggerFollowUpQuestion(plan.modelId, signal, runEpoch, '');
        };
        flushKnowledgeSpeech();
      } else {
        setXiaozhiState('complete');
        await triggerFollowUpQuestion(
          plan.modelId,
          signal,
          runEpoch,
          knowledgeSpeechClosedRef.current ? '' : fullKnowledge,
        );
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        controlRef.current.zoomSpeed = 0;
        controlRef.current.voiceRotationActive = false;
        controlRef.current.rotationGestureActive = false;
        controlRef.current.rotationVelocity = { x: 0, y: 0 };
        if (interactionEpochRef.current === runEpoch) {
          setAgentThinking('智能体流程已被新的语音指令中断。');
          setAgentStatuses((current) => Object.fromEntries(
            Object.entries(current).map(([role, status]) => [role, status === 'thinking' || status === 'running' ? 'error' : status]),
          ) as Record<AgentRole, AgentStatus>);
          setAgentTimeline((items) => items.map((item) => item.status === 'running'
            ? { ...item, status: 'error', detail: `${item.detail}（流程已中断）` }
            : item));
          setXiaozhiState('idle');
        }
        return;
      }
      console.error('Agent run failed:', error);
      setIsKnowledgeStreaming(false);
      const isModelLoadError = error instanceof TeachingModelLoadError;
      const failureMessage = error instanceof Error ? error.message : '未知错误';
      setAgentThinking(isModelLoadError
        ? `模型加载异常：${failureMessage}`
        : '智能体流程异常：请检查网络或 DeepSeek 配置，系统仍可使用本地模型手动演示。');
      setAiAnalysis(isModelLoadError
        ? `${getTeachingModelName(error.modelId)}未能加载：${failureMessage}`
        : '多智能体演示失败，请检查 DeepSeek 配置或网络。');
      setAgentStatuses((current) => Object.fromEntries(
        Object.entries(current).map(([role, status]) => [role, status === 'thinking' || status === 'running' ? 'error' : status]),
      ) as Record<AgentRole, AgentStatus>);
      setAgentTimeline((items) => items.map((item) => item.status === 'running'
          ? { ...item, status: 'error', detail: isModelLoadError
            ? `${item.detail}（${failureMessage}）`
            : `${item.detail}（执行异常）` }
        : item));
      setXiaozhiState('idle');
      voiceConversationLoopRef.current = false;
    } finally {
      if (interactionEpochRef.current === runEpoch) setIsAgentRunning(false);
      if (ownedController && interactionAbortRef.current === ownedController) interactionAbortRef.current = null;
    }
  };

  const interruptTeachingPresentation = useCallback((analysisMessage: string) => {
    cancelVoiceTurn();
    interactionEpochRef.current += 1;
    interactionAbortRef.current?.abort();
    interactionAbortRef.current = null;
    cancelPendingTeachingModelLoad(new DOMException('Interaction aborted', 'AbortError'));
    stopXiaozhiSpeech();
    knowledgeSpeechClosedRef.current = true;
    knowledgeSpeechSessionRef.current += 1;
    onKnowledgeNarrationCompleteRef.current = null;
    pendingKnowledgeNarrationRef.current = null;
    answeredFollowUpQuestionIdRef.current = null;
    followUpSpeechEpochRef.current += 1;
    followUpTimelineIdRef.current = null;
    controlRef.current.zoomSpeed = 0;
    controlRef.current.voiceRotationActive = false;
    controlRef.current.rotationGestureActive = false;
    controlRef.current.rotationVelocity = { x: 0, y: 0 };
    setIsAgentRunning(false);
    setIsAgentRequestPending(false);
    setIsFollowUpPreparing(false);
    setIsKnowledgeStreaming(false);
    setKnowledgeContent('');
    setFollowUpQuestionReady(false);
    setFollowUpQuestion(null);
    setExpandedStructureImage(null);
    resetKnowledgeSpeech();
    setAgentThinking('');
    setAgentSummary('');
    setAgentTimeline([]);
    setAgentStatuses(AGENT_STATUS_IDLE);
    setXiaozhiState('analyzing');
    setAiAnalysis(analysisMessage);
  }, [cancelPendingTeachingModelLoad, cancelVoiceTurn, resetKnowledgeSpeech]);

  const handleVoiceBargeIn = useCallback(() => {
    interruptTeachingPresentation('已打断上一轮回答，正在听新的问题...');
  }, [interruptTeachingPresentation]);

  const handleXiaozhiRequest = async (request: string) => {
    const trimmedRequest = request.trim();
    if (!trimmedRequest) return;

    // ASR can deliver a final result without an interim transcript. Clear the
    // old explanation here as well as in onBargeIn so a new teaching request
    // never inherits the previous panel or split-stage layout.
    if (shouldInterruptTeachingPresentationForFinalUtterance(trimmedRequest)) {
      interruptTeachingPresentation('语音已识别，正在理解你的问题...');
    }

    const voiceTurn = beginVoiceTurn();
    setIsAgentRequestPending(true);
    prepareXiaozhiSpeech();

    let activeSessionId = learningSessionId;
    if (memorySettings.memoryEnabled && !activeSessionId) {
      try {
        const opened = await openLearningSession();
        activeSessionId = opened.session?.id || null;
        setLearningSessionId(activeSessionId);
        setMemorySettings(opened.settings);
      } catch (error) {
        console.warn('[Learning memory] Could not open session:', error);
      }
    }
    if (activeSessionId && memorySettings.memoryEnabled) {
      try {
        await appendLearningMessage(activeSessionId, 'user', trimmedRequest, {
          kind: 'utterance',
          modelId: currentTeachingModelId,
          modelName: fileName,
        });
      } catch (error) {
        console.warn('[Learning memory] User message save failed:', error);
      }
    }

    interactionAbortRef.current?.abort();
    const controller = new AbortController();
    interactionAbortRef.current = controller;
    const interactionEpoch = ++interactionEpochRef.current;
    voiceRequestStartedAtRef.current = performance.now();
    modelReadyAtRef.current = 0;

    setLastFinalVoiceText(trimmedRequest);
    setXiaozhiState('analyzing');
    setXiaozhiMessage('我在想一下，正在理解你的问题...');
    setAiAnalysis('语音已识别，正在理解你的问题...');
    setAgentStatuses((current) => ({ ...current, orchestrator: 'thinking' }));

    let streamedResponse = '';
    let streamedResponseState: XiaozhiVisualState = 'planning';
    const responseSpeech = createXiaozhiSpeechSession({
      onStart: () => {
        setIsXiaozhiSpeaking(true);
        if (voiceRequestStartedAtRef.current > 0) {
          const now = performance.now();
          const modelMark = modelReadyAtRef.current || now;
          console.info(
            `[Voice latency] model-first=${Math.round(modelMark - voiceRequestStartedAtRef.current)}ms `
            + `tts-first=${Math.round(now - modelMark)}ms `
            + `total=${Math.round(now - voiceRequestStartedAtRef.current)}ms`,
          );
          voiceRequestStartedAtRef.current = 0;
          modelReadyAtRef.current = 0;
        }
      },
      onEnd: () => {
        setIsXiaozhiSpeaking(false);
        setXiaozhiState((current) => current === streamedResponseState ? 'idle' : current);
        finishVoiceTurn(voiceTurn);
      },
      onError: (error) => reportVoicePlaybackError('Streaming response', error),
    });

    try {
      const decision = await buildOrchestratorDecision(trimmedRequest, {
        currentModelId: currentTeachingModelId,
        currentModelName: currentTeachingModelId ? getTeachingModelName(currentTeachingModelId) : fileName,
        currentModelSeedKey: activeModelSeedKey,
        hasModel: Boolean(modelUrl || activeContent === 'biodigital'),
        sessionId: activeSessionId,
      }, controller.signal, (token) => {
        if (controller.signal.aborted || interactionEpochRef.current !== interactionEpoch) return;
        if (!streamedResponse) modelReadyAtRef.current = performance.now();
        streamedResponse += token;
        setXiaozhiMessage(streamedResponse);
        responseSpeech.push(token);
      });
      throwIfAborted(controller.signal);
      if (interactionEpochRef.current !== interactionEpoch) return;
      if (!modelReadyAtRef.current && voiceRequestStartedAtRef.current > 0) modelReadyAtRef.current = performance.now();

      void logUserActivity({
        type: 'xiaozhi.conversation',
        payload: {
          userText: trimmedRequest,
          assistantText: decision.response,
        },
      });

      setAgentStatuses((current) => ({ ...current, orchestrator: 'done' }));
      streamedResponseState = decision.action === 'start_quiz'
        ? 'questioning'
        : decision.action === 'switch_model' || decision.action === 'control_model'
          ? 'executing'
          : decision.action === 'answer'
            ? 'explaining'
            : 'planning';
      setXiaozhiMessage(decision.response);
      setXiaozhiState(streamedResponseState);
      if (streamedResponse) responseSpeech.flush();
      else {
        responseSpeech.stop();
        letXiaozhiSpeak(decision.response, streamedResponseState);
      }
      if (activeSessionId && memorySettings.memoryEnabled && decision.response) {
        void appendLearningMessage(activeSessionId, 'assistant', decision.response, {
          kind: 'orchestrator_response',
          action: decision.action,
          modelId: decision.modelId || currentTeachingModelId,
        }).catch((error) => console.warn('[Learning memory] Assistant response save failed:', error));
      }

      if (decision.action === 'switch_model') {
        const targetModelId = decision.modelId || inferTeachingModel(trimmedRequest);
        const targetModelName = getTeachingModelName(targetModelId);
        const alreadyActive = currentTeachingModelId === targetModelId;

        if (!alreadyActive) {
          void loadTeachingModel(targetModelId, 'ai', controller.signal).catch((error) => {
            if ((error as Error).name === 'AbortError') return;
            console.error('Model switch failed:', error);
          });
        }

        setAgentStatuses(makeAgentStatuses({ orchestrator: 'done' }));
        setAgentThinking('');
        setAgentSummary('');
        setAgentTimeline([{
          id: `orchestrator-switch-${Date.now()}`,
          agent: 'orchestrator',
          title: alreadyActive ? '模型无需切换' : `切换到${targetModelName}`,
          detail: alreadyActive
            ? `${targetModelName}已经在当前展示区域中，未重复加载。`
            : `总调度已直接切换模型；未启动规划、执行、知识讲解或追问 Agent。`,
          status: 'done',
        }]);
        setAiAnalysis(alreadyActive ? `${targetModelName}已在展示中。` : `已切换到${targetModelName}。`);
        setXiaozhiState('complete');
        return;
      }

      if (decision.action === 'open_model_generation') {
        onOpenModelGeneration();
        return;
      }

      if (decision.action === 'start_quiz') {
        await triggerFollowUpQuestion(decision.modelId || currentTeachingModelId || undefined, controller.signal, interactionEpoch);
        return;
      }

      if (decision.action === 'control_model') {
        setXiaozhiState('executing');
        for (const call of decision.toolCalls || []) {
          await runAgentTool(call, controller.signal, decision.modelId || currentTeachingModelId || undefined);
        }
        setXiaozhiState('complete');
        return;
      }

      if (decision.action === 'teach_demo') {
        await handleAgentStart(decision.request || trimmedRequest, controller.signal, interactionEpoch, activeSessionId, decision.modelId);
        return;
      }

      setXiaozhiState('explaining');
      setAiAnalysis(decision.response);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        responseSpeech.stop();
        return;
      }
      responseSpeech.stop();
      console.error('Xiaozhi orchestrator failed:', error);
      setAgentStatuses((current) => ({ ...current, orchestrator: 'error' }));
      setXiaozhiState('idle');
      voiceConversationLoopRef.current = false;
      setAiAnalysis('小智暂时没想明白，请稍后再试或换个说法。');
    } finally {
      if (interactionAbortRef.current === controller) interactionAbortRef.current = null;
      setIsAgentRequestPending(false);
    }
  };

  const handleFollowUpAnswered = async (result: { isCorrect: boolean; feedback: string }) => {
    requestVoiceDeactivation();
    setFollowUpQuestionReady(false);
    setFollowUpRecognitionState({ phase: 'idle' });
    setAgentStatuses((current) => ({ ...current, questioner: 'done' }));
    if (followUpTimelineIdRef.current) {
      const timelineId = followUpTimelineIdRef.current;
      setAgentTimeline((items) => items.map((item) => item.id === timelineId
        ? { ...item, status: 'done', detail: `追问已完成：${result.isCorrect ? '回答正确' : '回答错误'}。` }
        : item));
    }
    setXiaozhiState(result.isCorrect ? 'complete' : 'explaining');
    if (learningSessionId && memorySettings.memoryEnabled) {
      void appendLearningMessage(learningSessionId, 'event', result.feedback, {
        kind: 'quiz_answer',
        isCorrect: result.isCorrect,
        modelId: currentTeachingModelId,
        question: followUpQuestion?.question || '',
      }).catch((error) => console.warn('[Learning memory] Quiz result save failed:', error));
    }
    await letXiaozhiSpeak(result.feedback, result.isCorrect ? 'complete' : 'explaining');
    answeredFollowUpQuestionIdRef.current = followUpQuestion?.id || null;
  };

  // Gesture classification is consumed directly through ControlRefs. Keep a
  // stable callback for the camera overlay contract without putting the
  // per-result signal in React state.
  const handleGestureUpdate = useCallback(() => {}, []);

  const handlePartMoved = useCallback((partName: string) => {
    if (activeContent !== 'model' || !modelUrl) return;
    void logUserActivity({
      type: 'gesture.part.move',
      payload: {
        modelName: fileName || '当前 3D 模型',
        partName,
      },
    });
  }, [activeContent, fileName, modelUrl]);

  const handleInteractionModeChange = (mode: InteractionMode) => {
    if (mode === interactionMode) return;
    setInteractionMode(mode);
    resetControls();
    void logUserActivity({
      type: 'gesture.mode.switch',
      payload: { mode },
    });
    setAiAnalysis(mode === 'dual'
      ? '已切换为双手模式：左手缩放，右手旋转/拖拽。'
      : '已切换为单手模式：右手优先；双指旋转，张掌/握拳缩放，捏合拖拽；缩放与拖拽互斥。'
    );
  };

  useEffect(() => {
    if (!isFeedbackOpen) return undefined;

    const handleFeedbackKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && feedbackStatus !== 'submitting') {
        setIsFeedbackOpen(false);
      }
    };

    window.addEventListener('keydown', handleFeedbackKeyDown);
    return () => window.removeEventListener('keydown', handleFeedbackKeyDown);
  }, [isFeedbackOpen, feedbackStatus]);

  const openProfileSettings = () => {
    setProfileName(userLabel(currentUser));
    setProfileAvatar(currentUser.avatarUrl || '');
    setProfileMessage('');
    setProfileTab('profile');
    setIsAccountMenuOpen(false);
    setIsProfileOpen(true);
  };

  const openPasswordSettings = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setPasswordMessage('');
    setIsPasswordSuccess(false);
    setProfileTab('password');
  };

  const openFeedback = () => {
    setIsAccountMenuOpen(false);
    setFeedbackText('');
    setFeedbackStatus('idle');
    setFeedbackMessage('');
    setFeedbackAttachments((current) => {
      current.forEach((attachment) => URL.revokeObjectURL(attachment.preview));
      return [];
    });
    setIsFeedbackOpen(true);
  };

  const resetFeedback = () => {
    setFeedbackRating(0);
    setFeedbackScene('');
    setFeedbackSceneOther('');
    setFeedbackFeatures([]);
    setFeedbackVoiceAccuracy('');
    setFeedbackModelClarity('');
    setFeedbackText('');
    setFeedbackStatus('idle');
    setFeedbackMessage('');
    feedbackAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.preview));
    setFeedbackAttachments([]);
  };

  const closeFeedback = () => {
    if (feedbackStatus === 'submitting') return;
    setIsFeedbackOpen(false);
    if (feedbackStatus === 'success') resetFeedback();
  };

  const submitFeedback = async () => {
    const content = feedbackText.trim();
    const contentLength = Array.from(content).length;
    if (contentLength > 2000) {
      setFeedbackStatus('error');
      setFeedbackMessage('自由反馈需为 0-2000 个字符');
      return;
    }
    const hasAny = feedbackRating > 0
      || feedbackScene !== ''
      || feedbackFeatures.length > 0
      || feedbackVoiceAccuracy !== ''
      || feedbackModelClarity !== ''
      || content !== ''
      || feedbackAttachments.length > 0;
    if (!hasAny) {
      setFeedbackStatus('error');
      setFeedbackMessage('请至少填写一项反馈');
      return;
    }

    setFeedbackStatus('submitting');
    setFeedbackMessage('');
    try {
      const payload = {
          content,
          rating: feedbackRating || null,
          scene: feedbackScene || null,
          sceneOther: feedbackScene.trim() === 'other' && feedbackSceneOther.trim() ? feedbackSceneOther.trim() : null,
          features: feedbackFeatures,
          voiceAccuracy: feedbackVoiceAccuracy || null,
          modelClarity: feedbackModelClarity || null,
      };
      const formData = new FormData();
      formData.append('payload', JSON.stringify(payload));
      feedbackAttachments.forEach((attachment) => formData.append('attachments', attachment.file, attachment.name));
      const response = await fetch('/api/feedback', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) throw new Error(await readError(response));
      setFeedbackStatus('success');
      setFeedbackMessage('感谢你的反馈，我们已经收到。');
    } catch (error) {
      setFeedbackStatus('error');
      setFeedbackMessage(error instanceof Error ? error.message : '反馈提交失败，请稍后重试');
    }
  };

  const handleFeedbackAttachmentChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = '';
    if (selected.length === 0) return;
    if (feedbackAttachments.length + selected.length > 3) {
      setFeedbackStatus('error');
      setFeedbackMessage('每条反馈最多上传 3 张图片');
      return;
    }
    try {
      const next = await Promise.all(selected.map(compressFeedbackImage));
      setFeedbackAttachments((current) => [...current, ...next]);
      setFeedbackStatus('idle');
      setFeedbackMessage('');
    } catch (error) {
      setFeedbackStatus('error');
      setFeedbackMessage(error instanceof Error ? error.message : '图片处理失败');
    }
  };

  const removeFeedbackAttachment = (index: number) => {
    setFeedbackAttachments((current) => {
      const removed = current[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const loadMemoryCenter = async () => {
    setProfileTab('memory');
    setMemoryMessage('');
    setIsAccountMenuOpen(false);
    setIsProfileOpen(true);
    setIsMemoryLoading(true);
    try {
      const memories = await listLearningMemories();
      setLearningMemories(memories);
    } catch (error) {
      setMemoryMessage(error instanceof Error ? error.message : '学习记忆加载失败');
    } finally {
      setIsMemoryLoading(false);
    }
  };

  const toggleLongTermMemory = async () => {
    setMemoryMessage('');
    try {
      const settings = await updateMemorySettings({ memoryEnabled: !memorySettings.memoryEnabled, noticeSeen: true });
      setMemorySettings(settings);
      if (settings.memoryEnabled) {
        const opened = await openLearningSession();
        setLearningSessionId(opened.session?.id || null);
      }
    } catch (error) {
      setMemoryMessage(error instanceof Error ? error.message : '记忆设置保存失败');
    }
  };

  const saveEditedMemory = async (id: number) => {
    try {
      const memory = await updateLearningMemory(id, editingMemoryContent);
      setLearningMemories((current) => current.map((item) => item.id === id ? memory : item));
      setEditingMemoryId(null);
    } catch (error) {
      setMemoryMessage(error instanceof Error ? error.message : '记忆修改失败');
    }
  };

  const removeMemory = async (id: number) => {
    try {
      await deleteLearningMemory(id);
      setLearningMemories((current) => current.filter((item) => item.id !== id));
    } catch (error) {
      setMemoryMessage(error instanceof Error ? error.message : '记忆删除失败');
    }
  };

  const clearAllMemories = async () => {
    if (!window.confirm('确定清空全部长期学习记忆吗？会话原文和摘要不会因此删除。')) return;
    try {
      await clearLearningMemories();
      setLearningMemories([]);
      setMemoryMessage('长期学习记忆已清空。');
    } catch (error) {
      setMemoryMessage(error instanceof Error ? error.message : '记忆清空失败');
    }
  };

  const handleAvatarChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setProfileMessage('');
    setIsAvatarProcessing(true);

    try {
      const dataUrl = await resizeAvatarFile(file);
      setProfileAvatar(dataUrl);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '头像处理失败');
    } finally {
      setIsAvatarProcessing(false);
    }
  };

  const saveProfile = async () => {
    setProfileMessage('');
    setIsSavingProfile(true);

    try {
      const response = await fetch('/api/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: profileName,
          avatarUrl: profileAvatar,
        }),
      });

      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      onUserUpdated(data.user);
      setIsProfileOpen(false);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '个人资料保存失败');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const changePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordMessage('');
    setIsPasswordSuccess(false);

    if (!currentPassword) {
      setPasswordMessage('请输入当前密码');
      return;
    }

    if (newPassword.length < 6 || newPassword.length > 128) {
      setPasswordMessage('新密码需为 6-128 位');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordMessage('两次输入的新密码不一致');
      return;
    }

    if (currentPassword === newPassword) {
      setPasswordMessage('新密码不能与当前密码相同');
      return;
    }

    setIsSavingPassword(true);
    try {
      const response = await fetch('/api/profile/password', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!response.ok) throw new Error(await readError(response));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setIsPasswordSuccess(true);
      setPasswordMessage('密码修改成功');
    } catch (error) {
      setPasswordMessage(error instanceof Error ? error.message : '密码修改失败，请稍后重试');
    } finally {
      setIsSavingPassword(false);
    }
  };

  // Sync interaction speed settings to controlRef
  useEffect(() => {
    controlRef.current.interactionSettings = {
      zoomSpeed: zoomSpeedMultiplier,
      rotationSpeed: rotationSpeedMultiplier,
    };
  }, [zoomSpeedMultiplier, rotationSpeedMultiplier]);

  return (
    <div className={`lab-shell flex h-screen flex-col overflow-hidden text-ink ${playIntro ? 'lab-intro' : ''} ${isStageAppFullscreen ? 'lab-shell-app-fullscreen' : ''}`}>
      <div className="lab-stars" aria-hidden="true" />
      <div className="lab-ambient lab-ambient-left" aria-hidden="true" />
      <div className="lab-ambient lab-ambient-bottom" aria-hidden="true" />
      {/* 顶部导航 */}
      <nav
        className="relative z-50 flex h-[84px] items-center justify-between px-7"
        aria-hidden={isStageAppFullscreen || undefined}
      >
        <div className="flex items-center gap-6">
          <div 
            className="flex items-center space-x-3 cursor-pointer hover:opacity-80 transition-opacity"
            onClick={onBack}
          >
            <img src="/brand/smart-cube-tech/mark.svg" alt="数智课堂 Logo" className="h-10 w-10 drop-shadow-[0_0_18px_rgba(var(--theme-accent-rgb),0.46)]" />
            <div className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-ink">数智课堂</span>
              <span className="text-xs font-semibold tracking-wide text-ink-soft">AI 沉浸式教学系统</span>
            </div>
          </div>

        </div>

        <div className="flex items-center gap-5">
          <button type="button" className="lab-pill-button" onClick={onOpenModelGeneration}>
            <Sparkles className="mr-1.5 text-ink/90" size={14} /> 3D建模生成
          </button>

          <div className="relative group">
            <input
              type="file"
              accept=".fbx,.glb,.gltf,.bin,.ktx,.ktx2,.dds,.tga,.bmp,image/*"
              multiple
              disabled={isSavingLocalModel}
              onChange={handleModelUpload}
              className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
            />
            <button className="lab-pill-button" disabled={isSavingLocalModel}>
              {isSavingLocalModel ? <Loader2 className="mr-1.5 animate-spin text-ink/90" size={14} /> : <Download className="mr-1.5 text-ink/90" size={14} />}
              {isSavingLocalModel ? '保存中' : '导入模型'}
            </button>
          </div>

          <button
            type="button"
            className={`lab-pill-button ${xiaozhiVoiceActive ? 'lab-pill-button-live' : ''}`}
            onClick={() => {
              setSidebarTab('agent');
              setIsSidebarCollapsed(false);
              cancelVoiceTurn();
              if (!xiaozhiVoiceActive) {
                stopXiaozhiSpeech();
                globalSpeechActiveRef.current = false;
                setGlobalSpeechActive(false);
                setIsXiaozhiSpeaking(false);
                setIsAgentRequestPending(false);
                setIsFollowUpPreparing(false);
                setXiaozhiState('idle');
              }
              voiceConversationLoopRef.current = !xiaozhiVoiceActive;
              setForceVoiceToggle((current) => current + 1);
            }}
            title={xiaozhiVoiceActive ? '点击关闭语音输入' : '点击开始语音输入'}
            aria-label={xiaozhiVoiceActive ? '关闭语音输入' : '开始语音输入'}
          >
            <XiaozhiMascot size={15} motion={xiaozhiVoiceActive ? 'stateful' : 'static'} /> 小智
          </button>

          <ThemeSwitcher />

          <div className="relative">
            <button
              type="button"
              onClick={() => setIsAccountMenuOpen((open) => !open)}
              className="flex h-10 items-center gap-1.5 rounded-full border border-cyan/30 bg-cyan-50 px-2 pr-3 text-cyan shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-cyan/50 hover:bg-cyan-100"
              aria-label="打开个人中心"
            >
              <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full border border-line/15 bg-cyan-200 text-xs font-black text-[#061626]">
                {currentUser.avatarUrl ? (
                  <img src={currentUser.avatarUrl} alt={userLabel(currentUser)} className="h-full w-full object-cover" />
                ) : (
                  userInitial(currentUser)
                )}
              </span>
              <span className="max-w-[100px] truncate text-xs font-bold text-ink-soft">{userLabel(currentUser)}</span>
              <ChevronDown className={`h-3.5 w-3.5 text-cyan transition ${isAccountMenuOpen ? 'rotate-180' : ''}`} />
            </button>

            {isAccountMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+10px)] z-[80] w-44 overflow-hidden rounded-xl border border-line/12 bg-cyan-50/95 p-1.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
                <button
                  type="button"
                  onClick={openProfileSettings}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink/82 transition hover:bg-cyan-300/10 hover:text-ink"
                >
                  <Settings className="h-4 w-4" />
                  个人设置
                </button>
                <button
                  type="button"
                  onClick={() => void loadMemoryCenter()}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink/82 transition hover:bg-cyan-300/10 hover:text-ink"
                >
                  <MessageSquare className="h-4 w-4" />
                  学习记忆
                </button>
                <button
                  type="button"
                  onClick={openFeedback}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink/82 transition hover:bg-cyan-300/10 hover:text-ink"
                >
                  <MessageSquare className="h-4 w-4" />
                  使用反馈
                </button>
                {onOpenAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      onOpenAdmin();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-cyan transition hover:bg-cyan-300/10 hover:text-ink"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    管理后台
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setIsAccountMenuOpen(false);
                    onLogout();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink/82 transition hover:bg-red-400/10 hover:text-red-100"
                >
                  <LogOut className="h-4 w-4" />
                  退出
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {memorySettings.memoryEnabled && !memorySettings.noticeSeen && (
        <div className="absolute left-1/2 top-[76px] z-[90] flex w-[min(620px,calc(100%-32px))] -translate-x-1/2 items-center gap-4 rounded-xl border border-cyan/25 bg-cyan-50/95 px-4 py-3 text-sm text-cyan shadow-2xl backdrop-blur-xl">
          <XiaozhiMascot state="idle" size={34} motion="subtle" ariaLabel="小智" />
          <p className="min-w-0 flex-1">小智会保存课堂对话摘要和有用的学习偏好，帮助你下次继续学习。你可以随时在“学习记忆”中查看、修改、关闭或清空。</p>
          <button
            type="button"
            onClick={() => void updateMemorySettings({ noticeSeen: true }).then(setMemorySettings)}
            className="shrink-0 rounded-lg bg-cyan-200 px-3 py-2 text-xs font-black text-[#061626]"
          >
            我知道了
          </button>
        </div>
      )}

      {isFeedbackOpen && (
        <div
          className="fixed inset-0 z-[120] grid place-items-center bg-black/50 px-5 backdrop-blur-md"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFeedback();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
            aria-describedby="feedback-dialog-description"
            className="w-full max-w-xl max-h-[86vh] overflow-y-auto rounded-2xl border border-black/10 bg-cyan-50/96 p-6 text-ink shadow-2xl shadow-black/60"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan/55">Feedback</p>
                <h2 id="feedback-dialog-title" className="mt-2 text-2xl font-black">使用反馈</h2>
                <p id="feedback-dialog-description" className="mt-2 text-sm leading-6 text-ink/55">
                  所有题目均非强制，选填任意项即可提交。
                </p>
              </div>
              <button
                type="button"
                onClick={closeFeedback}
                disabled={feedbackStatus === 'submitting'}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line/10 bg-white/5 text-ink/60 transition hover:bg-white/10 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="关闭使用反馈"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {feedbackStatus === 'success' ? (
              <div className="mt-6 rounded-xl border border-emerald-300/20 bg-emerald-400/10 px-4 py-5 text-sm leading-6 text-emerald-50" role="status" aria-live="polite">
                {feedbackMessage}
              </div>
            ) : (
              <div className="mt-6 space-y-6">
                {/* ⭐ 整体满意度 5星（支持半星） */}
                <div>
                  <span className="text-sm font-bold text-ink/75">整体满意度</span>
                  <div className="mt-2 flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((star) => {
                      const current = feedbackRating;
                      const starValue = star;
                      const halfValue = star - 0.5;
                      const isFull = current >= starValue;
                      const isHalf = !isFull && current >= halfValue;
                      return (
                        <div key={star} className="relative h-8 w-8">
                          {/* 整颗按钮 */}
                          <button
                            type="button"
                            onClick={() => {
                              setFeedbackRating(current === starValue ? 0 : starValue);
                              if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                            }}
                            className="absolute inset-0 grid place-items-center rounded transition active:scale-90"
                            aria-label={`${star} 星`}
                          >
                            <Star
                              className={`h-7 w-7 transition-colors ${isFull ? 'fill-amber-400 text-amber-400' : 'text-ink/20'}`}
                            />
                          </button>
                          {/* 左半边按钮（点半星） */}
                          {!isFull && (
                            <button
                              type="button"
                              onClick={() => {
                                setFeedbackRating(current === halfValue ? 0 : halfValue);
                                if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                              }}
                              className="absolute left-0 top-0 z-10 h-8 w-4 overflow-hidden grid place-items-center rounded-l"
                              aria-label={`${halfValue} 星`}
                            >
                              <Star className={`h-7 w-7 -ml-1 ${isHalf ? 'fill-amber-400 text-amber-400' : 'text-transparent'}`} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <span className="ml-2 text-sm text-ink/50">
                      {feedbackRating > 0 ? `${feedbackRating} 星` : '未打分'}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-ink/35">点左边半个 = 半星，点右边整颗 = 整星</div>
                </div>

                {/* 📍 单选：使用场景 */}
                <div>
                  <span className="text-sm font-bold text-ink/75">你最常在哪个场景使用？（单选）</span>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[
                      { value: 'classroom', label: '课堂教学' },
                      { value: 'self', label: '个人自学' },
                      { value: 'demo', label: '展示演示' },
                      { value: 'other', label: '其他' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          if (opt.value !== 'other') setFeedbackSceneOther('');
                          setFeedbackScene(feedbackScene === opt.value ? '' : opt.value);
                          if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                        }}
                        className={`h-9 rounded-lg border text-sm transition ${
                          feedbackScene === opt.value
                            ? 'border-cyan/60 bg-cyan-300/15 text-ink'
                            : 'border-line/10 bg-white/5 text-ink/55 hover:bg-white/10 hover:text-ink/80'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  {feedbackScene === 'other' && (
                    <div className="mt-2">
                      <input
                        type="text"
                        value={feedbackSceneOther}
                        onChange={(e) => {
                          setFeedbackSceneOther(e.target.value);
                          if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                        }}
                        maxLength={80}
                        placeholder="请输入场景名称（选填）"
                        className="w-full rounded-lg border border-line/10 bg-white/[0.05] px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08]"
                      />
                      <div className="mt-1 text-xs text-ink/35">选填，不写也可以</div>
                    </div>
                  )}
                </div>

                {/* ✅ 多选：功能帮助 */}
                <div>
                  <span className="text-sm font-bold text-ink/75">哪些功能最有帮助？（可多选）</span>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {[
                      { value: '3d', label: '3D 模型展示' },
                      { value: 'voice', label: '语音交互' },
                      { value: 'quiz', label: '答题测验' },
                      { value: 'explain', label: '知识讲解' },
                      { value: 'holo', label: '全息指令表' },
                      { value: 'wrongbook', label: '错题本' },
                      { value: 'theme', label: '主题切换' },
                      { value: 'memory', label: '学习记忆' },
                    ].map((opt) => {
                      const checked = feedbackFeatures.includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => {
                            setFeedbackFeatures(prev => checked ? prev.filter(v => v !== opt.value) : [...prev, opt.value]);
                            if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                          }}
                          className={`h-9 rounded-lg border text-sm transition ${
                            checked
                              ? 'border-cyan/60 bg-cyan-300/15 text-ink'
                              : 'border-line/10 bg-white/5 text-ink/55 hover:bg-white/10 hover:text-ink/80'
                          }`}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            <span className={`inline-block h-3 w-3 rounded border ${checked ? 'border-cyan bg-cyan' : 'border-ink/30 bg-white/10'}`} />
                            {opt.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 🎙️ 单选：语音识别准确度 */}
                <div>
                  <span className="text-sm font-bold text-ink/75">语音识别准确度如何？（单选）</span>
                  <div className="mt-2 grid grid-cols-5 gap-2">
                    {[
                      { value: 'very_good', label: '非常准' },
                      { value: 'good', label: '比较准' },
                      { value: 'normal', label: '一般' },
                      { value: 'poor', label: '不太准' },
                      { value: 'bad', label: '很差' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setFeedbackVoiceAccuracy(feedbackVoiceAccuracy === opt.value ? '' : opt.value);
                          if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                        }}
                        className={`h-9 rounded-lg border text-xs transition ${
                          feedbackVoiceAccuracy === opt.value
                            ? 'border-cyan/60 bg-cyan-300/15 text-ink'
                            : 'border-line/10 bg-white/5 text-ink/55 hover:bg-white/10 hover:text-ink/80'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 🔬 单选：3D 模型清晰度 */}
                <div>
                  <span className="text-sm font-bold text-ink/75">3D 模型展示清晰度（单选）</span>
                  <div className="mt-2 grid grid-cols-5 gap-2">
                    {[
                      { value: 'very_clear', label: '非常清晰' },
                      { value: 'clear', label: '比较清晰' },
                      { value: 'normal', label: '一般' },
                      { value: 'blurry', label: '有点糊' },
                      { value: 'bad', label: '看不清' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setFeedbackModelClarity(feedbackModelClarity === opt.value ? '' : opt.value);
                          if (feedbackStatus === 'error') { setFeedbackStatus('idle'); setFeedbackMessage(''); }
                        }}
                        className={`h-9 rounded-lg border text-xs transition ${
                          feedbackModelClarity === opt.value
                            ? 'border-cyan/60 bg-cyan-300/15 text-ink'
                            : 'border-line/10 bg-white/5 text-ink/55 hover:bg-white/10 hover:text-ink/80'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ✍️ 自由填写大题 */}
                <label className="block">
                  <span className="text-sm font-bold text-ink/75">自由反馈（大题）</span>
                  <textarea
                    value={feedbackText}
                    onChange={(event) => {
                      setFeedbackText(event.target.value);
                      if (feedbackStatus === 'error') {
                        setFeedbackStatus('idle');
                        setFeedbackMessage('');
                      }
                    }}
                    maxLength={2000}
                    rows={5}
                    disabled={feedbackStatus === 'submitting'}
                    aria-invalid={feedbackStatus === 'error'}
                    className="mt-2 w-full resize-y rounded-xl border border-line/10 bg-white/[0.05] px-4 py-3 text-sm leading-6 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08] disabled:cursor-wait disabled:opacity-60"
                    placeholder="有什么想吐槽、建议或功能需求？随便写..."
                  />
                  <span className="mt-2 block text-right text-xs text-ink/35">{feedbackText.length} / 2000</span>
                </label>
                <div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-ink/75">图片附件（可选）</span>
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-cyan/30 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan hover:bg-cyan-300/20">
                      <Upload size={14} /> 添加图片
                      <input type="file" accept="image/png,image/jpeg,image/webp" multiple className="sr-only" onChange={handleFeedbackAttachmentChange} disabled={feedbackStatus === 'submitting' || feedbackAttachments.length >= 3} />
                    </label>
                  </div>
                  <p className="mt-1 text-xs text-ink/40">支持 PNG、JPEG、WebP，单张不超过 5MB，最多 3 张</p>
                  {feedbackAttachments.length > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      {feedbackAttachments.map((attachment, index) => (
                        <div key={`${attachment.name}-${index}`} className="group relative overflow-hidden rounded-lg border border-line/10 bg-black/10">
                          <img src={attachment.preview} alt={attachment.name} className="aspect-square w-full object-cover" />
                          <button type="button" onClick={() => removeFeedbackAttachment(index)} disabled={feedbackStatus === 'submitting'} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus:opacity-100" aria-label={`删除附件 ${attachment.name}`} title="删除附件"><Trash2 size={14} /></button>
                          <div className="truncate px-2 py-1 text-[10px] text-ink/60">{attachment.name}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {feedbackStatus === 'error' && (
              <div className="mt-4 rounded-lg border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100" role="alert">
                {feedbackMessage}
              </div>
            )}
            {feedbackStatus === 'submitting' && (
              <div className="mt-4 text-sm text-cyan/70" role="status" aria-live="polite">提交中，请稍候...</div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              {feedbackStatus === 'success' ? (
                <>
                  <button
                    type="button"
                    onClick={resetFeedback}
                    className="h-10 rounded-lg border border-cyan/20 bg-cyan-300/10 px-4 text-sm font-bold text-cyan transition hover:bg-cyan-300/16"
                  >
                    再提一条
                  </button>
                  <button
                    type="button"
                    onClick={closeFeedback}
                    className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] transition hover:bg-white"
                  >
                    关闭
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={closeFeedback}
                    disabled={feedbackStatus === 'submitting'}
                    className="h-10 rounded-lg border border-line/10 bg-white/5 px-4 text-sm font-bold text-ink/70 transition hover:bg-white/10 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitFeedback()}
                    disabled={feedbackStatus === 'submitting'}
                    className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {feedbackStatus === 'submitting' ? '提交中...' : '提交反馈'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {isProfileOpen && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 px-5">
          <div className={`w-full ${profileTab === 'memory' ? 'max-w-2xl' : 'max-w-md'} max-h-[86vh] overflow-y-auto rounded-2xl border border-cyan/18 bg-cyan-50/96 p-6 text-ink shadow-2xl shadow-black/60`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan/55">{profileTab === 'profile' ? 'Profile' : profileTab === 'voice' ? 'Voice' : profileTab === 'password' ? 'Security' : 'Learning Memory'}</p>
                <h2 className="mt-2 text-2xl font-black">{profileTab === 'profile' ? '个人设置' : profileTab === 'voice' ? '声音设置' : profileTab === 'password' ? '修改密码' : '学习记忆'}</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsProfileOpen(false)}
                className="grid h-9 w-9 place-items-center rounded-lg border border-line/10 bg-white/5 text-ink/60 transition hover:bg-white/10 hover:text-ink"
                aria-label="关闭个人设置"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {profileTab === 'profile' ? (
              <>
            <div className="mt-6 flex items-center gap-4">
              <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full border border-cyan/35 bg-cyan-200 text-2xl font-black text-[#061626] shadow-[0_0_28px_rgba(var(--theme-accent-rgb),0.24)]">
                {profileAvatar ? (
                  <img src={profileAvatar} alt="头像预览" className="h-full w-full object-cover" />
                ) : (
                  userInitial(currentUser)
                )}
              </div>
              <div className="min-w-0 flex-1">
                <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-cyan/20 bg-cyan-300/10 px-3 text-sm font-bold text-cyan transition hover:bg-cyan-300/16">
                  <Upload className="h-4 w-4" />
                  {isAvatarProcessing ? '处理中...' : '上传头像'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={handleAvatarChange}
                    className="sr-only"
                    disabled={isAvatarProcessing}
                  />
                </label>
                {profileAvatar && (
                  <button
                    type="button"
                    onClick={() => setProfileAvatar('')}
                    className="ml-3 text-sm font-semibold text-ink/45 transition hover:text-ink"
                  >
                    移除
                  </button>
                )}
                <p className="mt-2 text-xs leading-5 text-ink/42">支持 PNG、JPEG、WebP，保存前会自动压缩。</p>
              </div>
            </div>

            <label className="mt-6 block">
              <span className="text-sm font-bold text-ink/70">昵称</span>
              <input
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                maxLength={32}
                className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.05] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08]"
                placeholder="请输入昵称"
              />
            </label>

            <div className="mt-3 rounded-lg border border-line/8 bg-white/[0.03] px-3 py-2 text-xs text-ink/48">
              登录用户名：{currentUser.username}
            </div>

            {profileMessage && (
              <div className="mt-4 rounded-lg border border-red-300/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {profileMessage}
              </div>
            )}

            <div className="mt-6 grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => void loadMemoryCenter()}
                className="h-10 rounded-lg border border-cyan/20 bg-cyan-300/10 px-3 text-sm font-bold text-cyan transition hover:bg-cyan-300/16"
              >
                学习记忆
              </button>
              <button
                type="button"
                onClick={() => setProfileTab('voice')}
                className="h-10 rounded-lg border border-cyan/20 bg-cyan-300/10 px-3 text-sm font-bold text-cyan transition hover:bg-cyan-300/16"
              >
                声音设置
              </button>
              <button
                type="button"
                onClick={openPasswordSettings}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-cyan/20 bg-cyan-300/10 px-3 text-sm font-bold text-cyan transition hover:bg-cyan-300/16"
              >
                <LockKeyhole className="h-4 w-4" />
                修改密码
              </button>
            </div>
            <div className="mt-3 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsProfileOpen(false)}
                className="h-10 rounded-lg border border-line/10 bg-white/5 px-4 text-sm font-bold text-ink/70 transition hover:bg-white/10 hover:text-ink"
              >
                取消
              </button>
              <button
                type="button"
                onClick={saveProfile}
                disabled={isSavingProfile || isAvatarProcessing}
                className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-55"
              >
                {isSavingProfile ? '保存中...' : '保存'}
              </button>
            </div>
              </>
            ) : profileTab === 'voice' ? (
              <div className="mt-6">
                <div className="space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line/10 bg-white/[0.035] p-4">
                    <input type="radio" name="voice-mode" checked={voicePreference.mode === 'system'} onChange={() => setVoicePreference((current) => ({ ...current, mode: 'system' }))} className="mt-1 accent-cyan-300" />
                    <span><span className="block font-bold text-ink">系统默认声音</span><span className="mt-1 block text-xs leading-5 text-ink/45">直接使用当前浏览器和设备的默认播报声音。</span></span>
                  </label>
                  <label className="block">
                    <span className="text-sm font-bold text-ink/70">本机系统音色</span>
                    <select value={voicePreference.systemVoiceUri} onChange={(event) => setVoicePreference((current) => ({ ...current, mode: 'system', systemVoiceUri: event.target.value }))} className="mt-2 h-11 w-full rounded-lg border border-line/10 bg-cyan-50 px-3 text-sm text-ink outline-none focus:border-cyan/60">
                      <option value="">跟随设备默认声音</option>
                      {systemVoices.map((voice) => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}
                    </select>
                  </label>
                  <label className={`flex items-start gap-3 rounded-lg border p-4 ${isProviderVoiceAvailable ? 'cursor-pointer border-cyan/25 bg-cyan-300/[0.06]' : 'border-line/10 bg-white/[0.02] opacity-55'}`}>
                    <input type="radio" name="voice-mode" disabled={!isProviderVoiceAvailable} checked={voicePreference.mode === 'volcengine'} onChange={() => setVoicePreference((current) => ({ ...current, mode: 'volcengine', providerVoiceId: current.providerVoiceId || providerVoices[0]?.id || '' }))} className="mt-1 accent-cyan-300" />
                    <span><span className="flex items-center gap-2 font-bold text-ink"><Volume2 className="h-4 w-4 text-cyan" />真人音色</span><span className="mt-1 block text-xs leading-5 text-ink/45">DeepSeek 生成文字时实时合成播放。{isProviderVoiceAvailable ? '' : ' 服务端尚未配置，将自动使用系统默认声音。'}</span></span>
                  </label>
                  {isProviderVoiceAvailable && <label className="block"><span className="text-sm font-bold text-ink/70">真人音色</span><select value={voicePreference.providerVoiceId} onChange={(event) => setVoicePreference((current) => ({ ...current, mode: 'volcengine', providerVoiceId: event.target.value }))} className="mt-2 h-11 w-full rounded-lg border border-line/10 bg-cyan-50 px-3 text-sm text-ink outline-none focus:border-cyan/60">{providerVoices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name.replace(/^豆包/, '')}</option>)}</select></label>}
                </div>
                {voiceMessage && <div className="mt-4 rounded-lg border border-cyan/18 bg-cyan-300/8 px-4 py-3 text-sm text-cyan">{voiceMessage}</div>}
                <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setProfileTab('profile')} className="h-10 rounded-lg border border-line/10 bg-white/5 px-4 text-sm font-bold text-ink/70">返回</button><button type="button" onClick={() => void saveVoicePreference()} disabled={isSavingVoice} className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] disabled:opacity-55">{isSavingVoice ? '保存中...' : '保存声音'}</button></div>
              </div>
            ) : profileTab === 'password' ? (
              <form className="mt-6" onSubmit={changePassword}>
                <div className="flex items-start gap-3 rounded-xl border border-cyan/18 bg-cyan-300/[0.06] p-4">
                  <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-cyan" />
                  <p className="text-sm leading-6 text-ink/60">修改密码前需要验证当前密码。新密码需为 6-128 位，修改后当前登录状态会保留。</p>
                </div>

                <div className="mt-5 space-y-4">
                  <label className="block">
                    <span className="text-sm font-bold text-ink/70">当前密码</span>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      autoComplete="current-password"
                      disabled={isSavingPassword}
                      className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.05] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08] disabled:opacity-55"
                      placeholder="请输入当前密码"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-bold text-ink/70">新密码</span>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={isSavingPassword}
                      className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.05] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08] disabled:opacity-55"
                      placeholder="请输入 6-128 位新密码"
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm font-bold text-ink/70">确认新密码</span>
                    <input
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      minLength={6}
                      maxLength={128}
                      autoComplete="new-password"
                      disabled={isSavingPassword}
                      className="mt-2 h-12 w-full rounded-lg border border-line/10 bg-white/[0.05] px-4 text-ink outline-none transition placeholder:text-ink/28 focus:border-cyan/60 focus:bg-white/[0.08] disabled:opacity-55"
                      placeholder="请再次输入新密码"
                    />
                  </label>
                </div>

                {passwordMessage && (
                  <div className={`mt-4 rounded-lg border px-4 py-3 text-sm ${isPasswordSuccess ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100' : 'border-red-300/25 bg-red-500/10 text-red-100'}`} role={isPasswordSuccess ? 'status' : 'alert'}>
                    {passwordMessage}
                  </div>
                )}

                <div className="mt-6 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setProfileTab('profile')}
                    disabled={isSavingPassword}
                    className="h-10 rounded-lg border border-line/10 bg-white/5 px-4 text-sm font-bold text-ink/70 transition hover:bg-white/10 hover:text-ink disabled:opacity-40"
                  >
                    返回
                  </button>
                  <button
                    type="submit"
                    disabled={isSavingPassword}
                    className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    {isSavingPassword ? '修改中...' : '确认修改'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="mt-6">
                <div className="flex items-center justify-between gap-4 rounded-xl border border-line/10 bg-white/[0.04] p-4">
                  <div>
                    <p className="font-bold text-ink">长期学习记忆</p>
                    <p className="mt-1 text-xs leading-5 text-ink/48">开启后逐轮保存课堂对话，原文保留 30 天；摘要和学习记忆会一直保留到你删除。</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={memorySettings.memoryEnabled}
                    onClick={() => void toggleLongTermMemory()}
                    className={`relative h-7 w-12 shrink-0 rounded-full transition ${memorySettings.memoryEnabled ? 'bg-cyan-300' : 'bg-white/15'}`}
                  >
                    <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition ${memorySettings.memoryEnabled ? 'left-6' : 'left-1'}`} />
                  </button>
                </div>

                {memoryMessage && (
                  <div className="mt-4 rounded-lg border border-cyan/18 bg-cyan-300/8 px-4 py-3 text-sm text-cyan">{memoryMessage}</div>
                )}

                <div className="mt-5 flex items-center justify-between">
                  <p className="flex items-center gap-2 text-sm font-black text-ink/75">
                    <XiaozhiMascot state="idle" size={20} motion="static" />
                    <span>小智记住的内容</span>
                  </p>
                  {learningMemories.length > 0 && (
                    <button type="button" onClick={() => void clearAllMemories()} className="text-xs font-bold text-red-200/70 transition hover:text-red-100">清空全部</button>
                  )}
                </div>

                <div className="mt-3 space-y-3">
                  {isMemoryLoading ? (
                    <div className="py-10 text-center text-sm text-ink/45">正在读取学习记忆...</div>
                  ) : learningMemories.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line/12 px-5 py-10 text-center text-sm leading-6 text-ink/42">
                      还没有长期学习记忆。和小智完成一些课堂对话后，这里会出现学习偏好、已学主题和掌握情况。
                    </div>
                  ) : learningMemories.map((memory) => (
                    <div key={memory.id} className="rounded-xl border border-line/10 bg-white/[0.035] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="rounded-md bg-cyan-300/10 px-2 py-1 text-[11px] font-black text-cyan">{MEMORY_CATEGORY_LABELS[memory.category]}</span>
                        <span className="text-[11px] text-ink/32">{new Date(memory.updatedAt).toLocaleDateString('zh-CN')}</span>
                      </div>
                      {editingMemoryId === memory.id ? (
                        <div className="mt-3 flex gap-2">
                          <input
                            value={editingMemoryContent}
                            onChange={(event) => setEditingMemoryContent(event.target.value)}
                            maxLength={800}
                            className="h-10 min-w-0 flex-1 rounded-lg border border-cyan/35 bg-cyan/20 px-3 text-sm text-ink outline-none"
                          />
                          <button type="button" onClick={() => void saveEditedMemory(memory.id)} className="rounded-lg bg-cyan-200 px-3 text-xs font-black text-[#061626]">保存</button>
                          <button type="button" onClick={() => setEditingMemoryId(null)} className="rounded-lg border border-line/10 px-3 text-xs text-ink/60">取消</button>
                        </div>
                      ) : (
                        <p className="mt-3 text-sm leading-6 text-ink/78">{memory.content}</p>
                      )}
                      {editingMemoryId !== memory.id && (
                        <div className="mt-3 flex items-center gap-3">
                          <button type="button" onClick={() => { setEditingMemoryId(memory.id); setEditingMemoryContent(memory.content); }} className="text-xs font-bold text-cyan/65 transition hover:text-cyan">编辑</button>
                          <button type="button" onClick={() => void removeMemory(memory.id)} className="text-xs font-bold text-red-200/55 transition hover:text-red-100">删除</button>
                          {memory.sourceSummary && <span className="ml-auto max-w-[55%] truncate text-[11px] text-ink/28" title={memory.sourceSummary}>来源：{memory.sourceSummary}</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-6 flex justify-between">
                  <button type="button" onClick={openProfileSettings} className="h-10 rounded-lg border border-line/10 bg-white/5 px-4 text-sm font-bold text-ink/70 transition hover:bg-white/10 hover:text-ink">返回个人设置</button>
                  <button type="button" onClick={() => setIsProfileOpen(false)} className="h-10 rounded-lg bg-cyan-200 px-5 text-sm font-black text-[#061626] transition hover:bg-white">完成</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 主体区域 */}
      <main className={`lab-workspace relative z-10 flex-1 overflow-hidden px-6 pb-6 ${isSidebarCollapsed ? 'is-sidebar-collapsed' : ''} ${detailPanelVisible ? 'has-detail-panel' : ''}`}>
        {/* 侧边栏 */}
        <aside
          className={`lab-sidebar flex min-h-0 flex-col transition-all ${playIntro ? 'lab-sidebar-enter' : ''} ${isSidebarCollapsed ? 'is-collapsed items-center overflow-hidden p-3' : 'lab-sidebar-expanded overflow-y-auto p-5'}`}
          aria-hidden={isStageAppFullscreen || undefined}
        >
          {isSidebarCollapsed ? (
            <>
              <button
                type="button"
                onClick={() => setIsSidebarCollapsed(false)}
                className="lab-icon-button mb-5"
                aria-label="展开侧边栏"
                title="展开侧边栏"
              >
                <ChevronRight size={18} />
              </button>

              <div className="flex w-full flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setSidebarTab('resource');
                    setExpandedCategories((current) => new Set(current).add(LOCAL_MODELS_CATEGORY_KEY));
                    setIsSidebarCollapsed(false);
                  }}
                  className={`lab-icon-button ${activeLocalModelId ? 'is-active' : ''}`}
                  aria-label="我的模型"
                  title="我的模型"
                >
                  <FolderOpen size={19} />
                </button>
                {resourceTags.map((tag) => {
                  const TagIcon = RESOURCE_TAG_ICONS[tag.iconKey] || Box;
                  const firstModel = tag.models[0];
                  const isActive = activeLocalModelId === null && tag.models.some((model) => model.url === modelUrl);
                  return (
                    <React.Fragment key={tag.id}>
                      <div className="my-2 h-px w-8 bg-white/5" />
                      <button
                        type="button"
                        onClick={() => {
                          if (firstModel?.url) {
                            loadDemoModel(firstModel.url, firstModel.name, firstModel.type, firstModel.assets, 'resource', firstModel.seedKey);
                          } else {
                            setSidebarTab('resource');
                            setExpandedCategories((current) => new Set(current).add(resourceCategoryKey(tag.id)));
                            setIsSidebarCollapsed(false);
                          }
                        }}
                        className={`lab-icon-button ${isActive ? 'is-active' : ''}`}
                        aria-label={tag.name}
                        title={firstModel ? `${tag.name} · ${firstModel.name}` : tag.name}
                      >
                        <TagIcon size={19} />
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              <div className="mt-auto flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (activeContent === 'biodigital') {
                      setAiAnalysis('心脏模型2 是 URL 交互展示页面；本地手势控制会在心脏模型等 GLB 模型视图中启用。');
                      return;
                    }
                    setCameraActive(!cameraActive);
                  }}
                  className={`lab-icon-button h-14 w-14 ${activeContent === 'biodigital'
                    ? 'text-slate-500'
                    : cameraActive
                    ? 'is-active text-red-400'
                    : 'text-slate-500 hover:text-cyan'
                    }`}
                  aria-label={activeContent === 'biodigital' ? '心脏模型2 URL 交互' : cameraActive ? '停用摄像头' : '启用手势捕捉'}
                  title={activeContent === 'biodigital' ? '心脏模型2 URL 交互' : cameraActive ? '停用摄像头' : '启用手势捕捉'}
                >
                  <Hand size={18} />
                </button>
                <div className="h-px w-8 bg-white/70" />
                <MessageSquare className="text-blue-400" size={18} aria-label="助教日志" />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex flex-1 min-w-0 bg-slate-800/60 rounded-xl p-1 border border-slate-600/50 shadow-inner overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarTab('resource');
                        setIsSidebarCollapsed(false);
                      }}
                      className={`group relative order-2 flex-1 flex items-center justify-center gap-1 whitespace-nowrap px-2 py-1.5 rounded-lg text-[11px] font-black tracking-wide transition-all duration-200 active:scale-95 ${
                        sidebarTab === 'resource'
                          ? 'bg-gradient-to-r from-cyan-500/90 to-teal-500/90 text-white shadow-[0_0_10px_rgba(34,211,238,0.5)] ring-1 ring-cyan-300/50'
                          : 'text-slate-400 hover:text-cyan-300 hover:bg-slate-700/50'
                      }`}
                    >
                      <BookOpenCheck size={12} className={sidebarTab === 'resource' ? 'drop-shadow-[0_0_3px_rgba(255,255,255,0.6)]' : ''} />
                      学科资源库
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSidebarTab('agent');
                        setIsSidebarCollapsed(false);
                      }}
                      className={`group relative order-1 flex-1 flex items-center justify-center gap-1 whitespace-nowrap px-2 py-1.5 rounded-lg text-[11px] font-black tracking-wide transition-all duration-200 active:scale-95 ${
                        sidebarTab === 'agent'
                          ? 'bg-gradient-to-r from-violet-500/90 to-fuchsia-500/90 text-white shadow-[0_0_10px_rgba(167,139,250,0.5)] ring-1 ring-violet-300/50'
                          : 'text-slate-400 hover:text-violet-300 hover:bg-slate-700/50'
                      }`}
                    >
                      <Atom size={12} className={sidebarTab === 'agent' ? 'drop-shadow-[0_0_3px_rgba(255,255,255,0.6)] animate-pulse' : ''} />
                      多智能体
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsSidebarCollapsed(true);
                    }}
                    className="flex h-9 w-9 items-center justify-center rounded-xl bg-black/30 text-ink-soft shadow-sm transition hover:bg-black/40 hover:text-ink"
                    aria-label="收起"
                    title="收起"
                  >
                    <ChevronLeft size={17} />
                  </button>
                </div>

                {sidebarTab === 'resource' ? (
                <div className="space-y-1.5">
                  {/* 浏览器本地模型 */}
                  <div className="rounded-2xl overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedCategories(prev => {
                          const next = new Set(prev);
                          next.has(LOCAL_MODELS_CATEGORY_KEY)
                            ? next.delete(LOCAL_MODELS_CATEGORY_KEY)
                            : next.add(LOCAL_MODELS_CATEGORY_KEY);
                          return next;
                        });
                      }}
                      className="w-full p-2.5 flex items-center justify-between text-sm font-bold text-cyan hover:bg-cyan-300/15 transition-colors rounded-2xl"
                    >
                      <div className="flex items-center gap-2.5">
                        <FolderOpen size={16} className="text-cyan" />
                        <span>我的模型</span>
                        {visibleStaticModels.length + localModels.length > 0 && (
                          <span className="rounded-full bg-cyan-300/15 px-1.5 py-0.5 text-[9px] text-cyan">{visibleStaticModels.length + localModels.length}</span>
                        )}
                      </div>
                      <ChevronDown size={13} className={`text-cyan transition-transform duration-200 ${expandedCategories.has(LOCAL_MODELS_CATEGORY_KEY) ? 'rotate-180' : ''}`} />
                    </button>
                    {expandedCategories.has(LOCAL_MODELS_CATEGORY_KEY) && (
                      <div className="px-2 pb-2 space-y-0.5">
                        {visibleStaticModels.map((model) => (
                          <div key={model.id} className="relative group flex items-center w-full">
                            <button
                              type="button"
                              onClick={() => loadDemoModel(model.url, model.name, 'glb')}
                              title={model.name}
                              className={`w-full py-1.5 pl-2.5 pr-8 rounded-lg flex items-center text-left text-xs font-medium cursor-pointer transition-colors ${modelUrl === model.url ? 'bg-cyan-300/20 text-cyan' : 'text-ink-soft hover:bg-cyan-300/10'}`}
                            >
                              <span className={`w-1.5 h-1.5 shrink-0 rounded-full mr-2 ${modelUrl === model.url ? 'bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(var(--theme-accent-rgb),0.65)]' : 'bg-ink-soft/40'}`}></span>
                              <span className="truncate">{model.name}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => void handleHideStaticModel(e, model)}
                              className="absolute right-2 z-10 rounded p-1 text-ink-soft opacity-0 transition-all hover:bg-cyan-300/15 hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100"
                              title="从我的模型中移除"
                              aria-label={`从我的模型中移除：${model.name}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                        {localLibraryError ? (
                          <div className="px-2.5 py-2 text-[11px] leading-relaxed text-red-300">{localLibraryError}</div>
                        ) : localModels.map((model) => (
                          <div key={model.id} className="relative group flex items-center w-full">
                            <button
                              type="button"
                              onClick={() => void openLocalModel(model.id)}
                              title={`${model.name} · ${(model.size / 1024 / 1024).toFixed(1)} MB`}
                              className={`w-full py-1.5 pl-2.5 pr-8 rounded-lg flex items-center text-left text-xs font-medium cursor-pointer transition-colors ${activeLocalModelId === model.id ? 'bg-cyan-300/20 text-cyan' : 'text-ink-soft hover:bg-cyan-300/10'}`}
                            >
                              <span className={`w-1.5 h-1.5 shrink-0 rounded-full mr-2 ${activeLocalModelId === model.id ? 'bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(var(--theme-accent-rgb),0.65)]' : 'bg-ink-soft/40'}`}></span>
                              <span className="truncate">{model.name}</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => void handleDeleteLocalModel(e, model.id)}
                              className="absolute right-2 z-10 rounded p-1 text-ink-soft opacity-0 transition-all hover:bg-cyan-300/15 hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100"
                              title="删除模型"
                              aria-label={`删除模型：${model.name}`}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                        {visibleStaticModels.length === 0 && localModels.length === 0 && !localLibraryError && (
                          <div className="px-2.5 py-2 text-[11px] leading-relaxed text-ink-soft">图生建模完成后，点击"一键导入"即可保存到这里。</div>
                        )}
                      </div>
                    )}
                  </div>
                  {isResourceLibraryLoading && resourceTags.length === 0 && (
                    <div className="px-3 py-4 text-center text-[11px] text-slate-500">正在加载资源库...</div>
                  )}
                  {resourceLibraryError && (
                    <div className="px-3 py-2 text-[11px] leading-relaxed text-red-300">{resourceLibraryError}</div>
                  )}
                  {resourceTags.map((tag) => {
                    const categoryKey = resourceCategoryKey(tag.id);
                    const TagIcon = RESOURCE_TAG_ICONS[tag.iconKey] || Box;
                    const isExpanded = expandedCategories.has(categoryKey);
                    return (
                      <div key={tag.id} className="overflow-hidden rounded-2xl">
                        <button
                          type="button"
                          onClick={() => {
                            setExpandedCategories((current) => {
                              const next = new Set(current);
                              isExpanded ? next.delete(categoryKey) : next.add(categoryKey);
                              return next;
                            });
                          }}
                          className="flex w-full items-center justify-between rounded-2xl p-2.5 text-sm font-bold text-cyan transition-colors hover:bg-cyan-950/40"
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <TagIcon size={16} className="shrink-0 text-cyan" />
                            <span className="truncate">{tag.name}</span>
                            <span className="rounded-full bg-cyan-400/10 px-1.5 py-0.5 text-[9px] text-cyan">{tag.models.length}</span>
                          </span>
                          <ChevronDown size={13} className={`shrink-0 text-cyan transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        {isExpanded && (
                          <div className="space-y-0.5 px-2 pb-2">
                            {tag.models.length === 0 ? (
                              <div className="px-2.5 py-2 text-[11px] text-slate-500">暂无模型</div>
                            ) : tag.models.map((model) => {
                              const isActive = activeLocalModelId === null && modelUrl === model.url;
                              const modelProfile = getModelInfoProfile(model.seedKey || getModelSeedKeyByUrl(model.url));
                              return (
                                <button
                                  key={model.id}
                                  type="button"
                                  disabled={!model.url}
                                  onClick={() => loadDemoModel(model.url, model.name, model.type, model.assets, 'resource', model.seedKey)}
                                  title={model.size > 0 ? `${model.name} · ${(model.size / 1024 / 1024).toFixed(1)} MB` : model.name}
                                  className={`group/model flex w-full items-center gap-2.5 rounded-xl border px-2 py-2 text-left text-xs font-medium transition-all ${isActive ? 'border-cyan/35 bg-cyan-300/10 text-cyan shadow-[0_0_20px_rgba(34,211,238,0.08)]' : 'border-transparent text-ink-soft hover:border-line/8 hover:bg-white/[0.045] hover:text-ink-soft'} disabled:cursor-not-allowed disabled:opacity-50`}
                                >
                                  <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-line/8 bg-white/[0.045]">
                                    {modelProfile ? (
                                      <img src={modelProfile.illustration} alt="" className="h-full w-full object-cover transition duration-300 group-hover/model:scale-105" />
                                    ) : (
                                      <TagIcon size={16} className={isActive ? 'text-cyan' : 'text-slate-500'} />
                                    )}
                                  </span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate font-bold">{model.name}</span>
                                    <span className="mt-0.5 block truncate text-[9px] font-semibold uppercase tracking-wider text-slate-500">{modelProfile?.subtitle || tag.name}</span>
                                  </span>
                                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? 'animate-pulse bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.7)]' : 'bg-slate-700'}`} />
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                ) : (
                <div className="space-y-4">
                  <XiaozhiAssistant
                    state={xiaozhiState}
                    message={xiaozhiMessage}
                    voiceActive={xiaozhiVoiceActive}
                    assistantSpeaking={isXiaozhiSpeaking}
                    voiceInputDisabled={voiceInputDisabled}
                    onVoiceToggle={() => {
                      voiceConversationLoopRef.current = !xiaozhiVoiceActive;
                      setVoiceToggleRequest((current) => current + 1);
                    }}
                  />
                  <MultiAgentPanel
                    embedded
                    statuses={agentStatuses}
                    timeline={agentTimeline}
                    summary={agentSummary}
                    thinking={agentThinking}
                    isRunning={isAgentRunning || isFollowUpPreparing}
                    onStart={(request) => {
                      voiceConversationLoopRef.current = false;
                      void handleAgentStart(request);
                    }}
                  />
                </div>
                )}
              </div>

              <div>
                <h3 className="font-black text-xs text-ink-soft uppercase tracking-[0.2em] mt-2 mb-2 border-l-4 border-cyan pl-3">全息指令表</h3>
                <div className="space-y-4">
                  <div className="lab-instruction-card space-y-3 rounded-2xl p-3">
                    {/* Tab 切换 */}
                    <div className="lab-instruction-switch grid grid-cols-2 gap-1 rounded-xl p-1">
                      <button
                        type="button"
                        onClick={() => setInstructionTab('gesture')}
                        className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-black transition-all ${
                          instructionTab === 'gesture' ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-[0_3px_10px_rgba(0,210,255,0.22)]' : 'text-ink-soft hover:bg-white/[0.05] hover:text-ink'
                        }`}
                      >
                        <Hand size={11} /> 手势
                      </button>
                      <button
                        type="button"
                        onClick={() => setInstructionTab('voice')}
                        className={`flex items-center justify-center gap-1 rounded-lg py-1.5 text-[10px] font-black transition-all ${
                          instructionTab === 'voice' ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-[0_3px_10px_rgba(0,210,255,0.22)]' : 'text-ink-soft hover:bg-white/[0.05] hover:text-ink'
                        }`}
                      >
                        <Mic size={11} /> 语音
                      </button>
                    </div>

                    {instructionTab === 'gesture' ? (
                      <>
                        {/* 手势模式切换 */}
                        <div className="lab-instruction-switch grid grid-cols-2 gap-2 rounded-2xl p-1">
                          <button
                            type="button"
                            onClick={() => handleInteractionModeChange('dual')}
                            className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-[10px] font-black transition ${interactionMode === 'dual' ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-[0_3px_10px_rgba(0,210,255,0.22)]' : 'text-ink-soft hover:bg-white/[0.05] hover:text-ink'}`}
                          >
                            <Move3d size={13} /> 双手模式
                          </button>
                          <button
                            type="button"
                            onClick={() => handleInteractionModeChange('single')}
                            className={`flex items-center justify-center gap-1.5 rounded-xl py-2 text-[10px] font-black transition ${interactionMode === 'single' ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-white shadow-[0_3px_10px_rgba(0,210,255,0.22)]' : 'text-ink-soft hover:bg-white/[0.05] hover:text-ink'}`}
                          >
                            <Hand size={13} /> 单手模式
                          </button>
                        </div>

                        {interactionMode === 'dual' ? (
                          <>
                            <div className="flex items-center gap-2 pb-2 border-b border-cyan-500/30">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><Move3d size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">双手协同</span>
                                <span className="text-[9px] text-cyan font-bold">左手缩放 | 右手旋转/拖拽</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><Hand size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">左手缩放</span>
                                <span className="text-[9px] text-ink-soft font-bold">张开 → 放大 | 握拳 → 缩小</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><ScanFace size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">右手交互</span>
                                <span className="text-[9px] text-cyan font-bold">捏合 → 拖拽零件</span>
                                <span className="text-[9px] text-ink-soft font-bold">食指+中指并拢滑动 → 旋转画面</span>
                              </div>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 pb-2 border-b border-cyan-500/30">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><Hand size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">右手优先</span>
                                <span className="text-[9px] text-cyan font-bold">张掌放大 | 握拳缩小</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><Hand size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">捏合拖拽</span>
                                <span className="text-[9px] text-ink-soft font-bold">食指+拇指捏合 → 拖拽零件</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="lab-instruction-icon rounded-lg p-1.5"><ScanFace size={14} className="text-cyan" /></div>
                              <div className="flex flex-col">
                                <span className="text-[10px] font-black text-ink uppercase">互斥控制</span>
                                <span className="text-[9px] text-cyan font-bold">双指旋转优先；缩放与拖拽不会同时触发</span>
                              </div>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      /* 语音指令卡片 */
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          {[
                            { zh: '放大', en: 'big / zoom in' },
                            { zh: '缩小', en: 'small / zoom out' },
                            { zh: '转圈', en: 'spin / keep turning' },
                            { zh: '停止旋转', en: 'stop rotation / freeze' },
                          ].map((item) => (
                            <div key={item.zh} className="px-2 py-1.5 rounded-lg bg-slate-900/70 border border-cyan-500/40 text-center">
                              <div className="text-[11px] font-black text-white">{item.zh}</div>
                              <div className="text-[8px] text-cyan-300 font-bold tracking-wider">{item.en}</div>
                            </div>
                          ))}
                        </div>
                        <div className="text-center text-[9px] text-slate-400 pt-1 border-t border-cyan-500/30 space-y-0.5">
                          <div>点右下角麦克风开始说话 · 中英文均可识别</div>
                          <div className="text-cyan-400/80 text-[8px]">💡 建议连续说 2 次及以上关键词识别更稳</div>
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      if (activeContent === 'biodigital') {
                        setAiAnalysis('心脏模型2 是 URL 交互展示页面；本地手势控制会在心脏模型等 GLB 模型视图中启用。');
                        return;
                      }
                      setCameraActive(!cameraActive);
                    }}
                    className={`lab-gesture-capture-button w-full py-3 rounded-2xl text-[10px] font-black tracking-widest uppercase border transition-all ${activeContent === 'biodigital'
                      ? 'is-disabled cursor-not-allowed'
                      : cameraActive
                      ? 'is-active'
                      : ''
                      }`}
                  >
                    {activeContent === 'biodigital' ? '手势捕捉不可用' : cameraActive ? '停用摄像头' : '启用手势捕捉'}
                  </button>
                </div>
              </div>

              <div className="mt-auto pt-4">
                <div className="lab-assistant-log relative overflow-hidden rounded-2xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare size={14} className="text-cyan" />
                    <p className="text-[10px] text-cyan font-bold uppercase tracking-wider">助教日志</p>
                  </div>
                  <p className="text-xs text-ink-soft leading-relaxed font-medium italic min-h-[3em]">
                    "{aiAnalysis}"
                  </p>
                </div>
              </div>
            </>
          )}
        </aside>

        {/* 视口展示区 */}
        <section ref={stageRef} className={`lab-stage relative min-h-0 min-w-0 overflow-hidden group ${(isStageFullscreen || isStageAppFullscreen) ? 'h-screen w-screen rounded-none' : 'rounded-[30px]'} ${isStageAppFullscreen ? 'lab-stage-app-fullscreen' : ''} ${playIntro ? 'lab-stage-enter' : ''}`}>
          <div className="lab-stage-grid" aria-hidden="true" />
          <div className="lab-orbit lab-orbit-one" aria-hidden="true" />
          <div className="lab-orbit lab-orbit-two" aria-hidden="true" />
          <div className="lab-wire-cube lab-wire-cube-left" aria-hidden="true" />
          <div className="lab-wire-cube lab-wire-cube-right" aria-hidden="true" />

          {activeContent === 'model' && modelUrl && !quizMode && (
            <div className="lab-stage-tools" aria-label="模型工具">
              <button
                type="button"
                onClick={() => {
                  setDetailPanelOpen(true);
                  setDetailPanelTab('info');
                }}
                aria-pressed={detailPanelVisible && detailPanelTab === 'info'}
                className={`lab-stage-tool ${detailPanelVisible && detailPanelTab === 'info' ? 'is-active' : ''}`}
                title="打开模型资料"
              >
                {detailPanelVisible ? <Info size={18} /> : <PanelRightOpen size={18} />} <span>资料</span>
              </button>

              {modelUrl && (modelUrl.toLowerCase().includes('earth-layers') || modelUrl.toLowerCase().includes('terrain-topography')) && (
                <button
                  onClick={() => setShowLabels(!showLabels)}
                  aria-pressed={showLabels}
                  className={`lab-stage-tool ${showLabels ? 'is-active' : ''}`}
                  title={showLabels ? '关闭教学辅导标签' : '开启教学辅导标签'}
                >
                  <MessageSquare size={18} /> <span>标签</span>
                </button>
              )}

              <button
                ref={quizButtonRef}
                onClick={() => {
                  setQuizSubjectFilter(modelUrl);
                  setQuizMode(true);
                }}
                className="lab-stage-tool relative overflow-hidden"
                title="进入答题模式"
              >
                <span ref={quizProgressRef} className="absolute inset-y-0 left-0 bg-cyan-300/15" style={{ width: '0%' }} />
                <ClipboardCheck className="relative z-10" size={18} /> <span className="relative z-10">答题</span>
              </button>
              <button
                type="button"
                onClick={() => setWrongBookOpen(true)}
                className="lab-stage-tool relative overflow-hidden"
                title="打开错题本"
                data-testid="open-wrong-book"
              >
                <BookOpenCheck className="relative z-10" size={18} /> <span className="relative z-10">错题本</span>
              </button>
              <button
                type="button"
                onClick={() => setShowSettings((open) => !open)}
                aria-pressed={showSettings}
                className={`lab-stage-tool ${showSettings ? 'is-active' : ''}`}
                title="交互速度设置"
              >
                <Settings size={18} /> <span>设置</span>
              </button>
            </div>
          )}

          {!quizMode && !followUpQuestion && !detailPanelOpen && !isStageFullscreen && !isStageAppFullscreen && (
            <button
              type="button"
              onClick={() => {
                setDetailPanelOpen(true);
                setDetailPanelTab('info');
              }}
              className="absolute right-0 top-1/2 z-40 grid h-12 w-8 -translate-y-1/2 place-items-center rounded-l-xl border border-cyan/25 border-r-0 bg-cyan-950/85 text-cyan shadow-xl backdrop-blur-md transition hover:w-10 hover:bg-cyan-900"
              aria-label="展开模型资料"
              title="展开模型资料"
            >
              <PanelRightOpen size={17} />
            </button>
          )}

          {showSettings && activeContent === 'model' && (
            <div className="lab-stage-settings">
              <div className="mb-4 flex items-center justify-between">
                <h4 className="text-xs font-black tracking-wider text-ink-soft">交互速度</h4>
                <button type="button" onClick={() => setShowSettings(false)} className="text-slate-500 transition hover:text-ink" aria-label="关闭交互速度设置"><X size={16} /></button>
              </div>
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 flex items-center justify-between text-xs font-bold text-ink-soft"><span>缩放速度</span><b className="text-cyan">{zoomSpeedMultiplier.toFixed(1)}x</b></span>
                  <input type="range" min="0.1" max="5.0" step="0.1" value={zoomSpeedMultiplier} onChange={(event) => setZoomSpeedMultiplier(parseFloat(event.target.value))} className="w-full accent-cyan-300" />
                </label>
                <label className="block">
                  <span className="mb-1.5 flex items-center justify-between text-xs font-bold text-ink-soft"><span>旋转速度</span><b className="text-cyan">{rotationSpeedMultiplier.toFixed(1)}x</b></span>
                  <input type="range" min="0.1" max="5.0" step="0.1" value={rotationSpeedMultiplier} onChange={(event) => setRotationSpeedMultiplier(parseFloat(event.target.value))} className="w-full accent-cyan-300" />
                </label>
                <button type="button" onClick={() => { setZoomSpeedMultiplier(0.8); setRotationSpeedMultiplier(1.0); }} className="w-full rounded-xl border border-line/10 bg-white/[0.045] py-2 text-xs font-black text-ink-soft transition hover:border-cyan/25 hover:text-ink">恢复默认</button>
              </div>
            </div>
          )}

          {expandedStructureImage && (
            <div
              className="absolute inset-0 z-[70] flex items-center justify-center bg-cyan/35 p-6 backdrop-blur-sm"
              onClick={() => setExpandedStructureImage(null)}
              role="dialog"
              aria-modal="true"
              aria-label="结构图放大预览"
            >
              <button
                type="button"
                onClick={() => setExpandedStructureImage(null)}
                className="absolute right-6 top-6 flex h-10 w-10 items-center justify-center rounded-xl bg-white/90 text-gray-500 shadow-lg transition hover:bg-white hover:text-gray-800"
                aria-label="关闭结构图预览"
                title="关闭"
              >
                <X size={18} />
              </button>
              <img
                src={expandedStructureImage}
                alt="Chemical structure enlarged"
                className="max-h-[86%] max-w-[86%] rounded-2xl bg-white object-contain shadow-2xl"
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          )}

          <div className="absolute top-6 right-6 flex gap-2 z-40">
            <button
              type="button"
              onClick={toggleStageFullscreen}
              className="lab-square-button"
              aria-label={(isStageFullscreen || isStageAppFullscreen) ? '退出全屏' : '展示区全屏'}
              title={(isStageFullscreen || isStageAppFullscreen) ? '退出全屏' : '展示区全屏'}
            >
              {(isStageFullscreen || isStageAppFullscreen) ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          </div>

          {/* 3D 模型层 */}
          <div
            className="absolute inset-0 z-10 h-full w-full opacity-100"
          >
            {activeContent === 'biodigital' ? (
              <BioDigitalViewer src={BIODIGITAL_HEART_URL} onFallback={loadHeartFallbackModel} />
            ) : modelUrl ? (
              <>
                <ModelViewer
                  key={`${modelUrl}:${modelLoadRevision}`}
                  modelUrl={modelUrl}
                  modelType={modelType}
                  assetUrls={modelAssetUrls}
                  controlRef={controlRef}
                  showLabels={showLabels}
                  onShowLabelsChange={setShowLabels}
                  onLoadProgress={(progress) => {
                    if (!isCurrentModelLoadEvent(modelUrl, modelUrlRef.current, modelLoadRevision, activeModelLoadRevisionRef.current)) return;
                    setModelLoadError(null);
                    setLoadProgress(progress);
                  }}
                  onLoadComplete={() => {
                    if (!isCurrentModelLoadEvent(modelUrl, modelUrlRef.current, modelLoadRevision, activeModelLoadRevisionRef.current)) return;
                    loadedModelUrlRef.current = modelUrl;
                    failedModelUrlRef.current = null;
                    setLoadProgress(null);
                    setModelLoadError(null);
                    settlePendingTeachingModelLoad(modelUrl);
                    const pendingActivity = pendingModelActivityRef.current;
                    if (pendingActivity && pendingActivity.modelUrl === modelUrl) {
                      pendingModelActivityRef.current = null;
                      void logUserActivity({
                        type: 'model.switch',
                        payload: {
                          ...(pendingActivity.fromModel ? { fromModel: pendingActivity.fromModel } : {}),
                          toModel: pendingActivity.toModel,
                          source: pendingActivity.source,
                        },
                      });
                    }
                  }}
                  onDisassemblyAvailabilityChange={(available) => {
                    if (!available) setAiAnalysis('当前模型为单网格，无法进行真实拆解；可通过旋转、缩放和资料说明继续观察。');
                  }}
                  onLoadError={modelViewerLoadErrorHandler}
                  onPartMoved={handlePartMoved}
                  quizMode={quizMode}
                />
                {modelLoadError !== null && (
                  <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/55 transition-opacity duration-300">
                    <div className="w-full max-w-md rounded-2xl border border-red-400/25 bg-slate-950/85 px-8 py-7 text-center shadow-2xl">
                      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-red-300/25 bg-red-500/10 text-red-200">
                        <Box size={22} />
                      </div>
                      <div className="text-base font-bold text-red-100">{modelLoadError.title}</div>
                      <div className="mt-2 text-sm leading-relaxed text-ink-soft">{modelLoadError.detail}</div>
                      <div className="mt-4 rounded-lg border border-line/10 bg-white/[0.04] px-3 py-2 text-xs text-ink-soft">
                        {fileName || '3D 模型'}
                      </div>
                    </div>
                  </div>
                )}
                {/* 模型加载进度：只保留紧凑的中央进度卡片，不遮盖整个舞台。 */}
                {modelLoadError === null && loadProgress !== null && loadProgress.percent < 100 && (
                  <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center transition-opacity duration-300">
                    <div className="w-full max-w-xs rounded-2xl border border-cyan/25 bg-slate-950/92 px-6 py-5 text-center shadow-2xl">
                      <div className="mb-1 text-sm font-bold text-white">正在加载模型</div>
                      <div className="mb-4 truncate text-xs text-slate-300">{fileName || '3D 模型'}</div>
                      <div className="mb-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-700/80">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300 ease-out"
                          style={{ width: `${loadProgress.percent}%` }}
                        />
                      </div>
                      <div className="text-right text-[11px] font-semibold text-cyan-200">
                        {loadProgress.percent}%
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="lab-welcome">
                <div className={`lab-cube-card ${playIntro ? 'lab-cube-enter' : ''}`}>
                  <Box className="lab-cube-icon" strokeWidth={1.55} />
                </div>
                <div className={`lab-welcome-copy ${introReady ? 'is-ready' : ''}`}>
                  <h2 className="lab-welcome-title">
                    欢迎来到 <span>数智课堂</span>
                  </h2>
                  <div className="lab-stream">
                    <b>交互指令：</b>
                    <p>
                      {streamedInstruction.split('\n').map((line, index) => (
                        <React.Fragment key={index}>
                          {line}
                          {index < streamedInstruction.split('\n').length - 1 && <br />}
                        </React.Fragment>
                      ))}
                      {streamedInstruction.length < INTRO_INSTRUCTION.length && <span className="lab-stream-cursor" />}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 摄像头预览区 */}
          {activeContent === 'model' && cameraActive && (
            <div className={`absolute bottom-6 right-6 w-56 h-40 rounded-3xl border-4 border-line shadow-2xl overflow-hidden bg-black transition-all hover:scale-105 ${quizMode ? 'opacity-0 pointer-events-none -z-10' : 'z-30'}`}>
              <HandController controlRef={controlRef} onStateChange={handleGestureUpdate} interactionMode={interactionMode} quizMode={quizMode} />
              {!quizMode && (
                <div className="absolute top-3 left-3 flex items-center gap-2">
                  <div className="bg-cyan w-2 h-2 rounded-full animate-pulse shadow-[0_0_8px_var(--theme-accent)]"></div>
                  <span className="text-[8px] font-black text-ink/70 uppercase tracking-widest">Vision Sensor</span>
                </div>
              )}
            </div>
          )}

          {quizMode && (
            <QuizOverlay
              stageRef={stageRef}
              controlRef={controlRef}
              cameraActive={cameraActive}
              onExit={() => setQuizMode(false)}
              subjectFilter={quizSubjectFilter}
              onComplete={(result, session) => {
                const wrongEntries = session.questions
                  .map((question, index) => ({ question, answer: session.answers[index] }))
                  .filter(({ question, answer }) => answer !== null && answer !== question.correctIndex)
                  .map(({ question, answer }) => ({
                    questionId: question.id,
                    subject: question.subject,
                    category: question.category,
                    question: question.question,
                    options: question.options,
                    userAnswerIndex: answer as number,
                    correctIndex: question.correctIndex,
                    explanation: question.explanation,
                  }));

                if (wrongEntries.length > 0) {
                  void submitWrongQuestions(wrongEntries).catch((error) =>
                    console.warn('[Wrong book] save failed:', error),
                  );
                }

                if (!learningSessionId || !memorySettings.memoryEnabled) return;
                const wrongQuestionIds = wrongEntries.map((entry) => entry.questionId);
                void appendLearningMessage(
                  learningSessionId,
                  'event',
                  `完成课堂测验：答对 ${result.correctCount}/${result.totalQuestions}，正确率 ${result.accuracy}%。`,
                  {
                    kind: 'quiz_session_result',
                    correctCount: result.correctCount,
                    totalQuestions: result.totalQuestions,
                    accuracy: result.accuracy,
                    wrongQuestionIds,
                    subjects: [...new Set(session.questions.map((question) => question.subject))],
                  },
                ).catch((error) => console.warn('[Learning memory] Quiz session save failed:', error));
              }}
            />
          )}

          <AnimatePresence initial={false}>
            {wrongBookOpen && (
              <WrongQuestionBook
                key="wrong-book"
                onBack={() => setWrongBookOpen(false)}
              />
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {followUpQuestion && (
              <FollowUpQuestionOverlay
                key={followUpQuestion.id}
                question={followUpQuestion}
                stageRef={stageRef}
                controlRef={controlRef}
                cameraActive={cameraActive}
                recognizedText={lastFinalVoiceText}
                recognitionState={followUpRecognitionState}
                questionReady={followUpQuestionReady}
                onAnswerInteractionReady={(questionId) => {
                  if (followUpQuestion?.id !== questionId || !followUpQuestionReady) return;
                  requestVoiceActivation('follow_up', questionId);
                }}
                onAnswered={handleFollowUpAnswered}
                onExit={() => {
                  const pendingNarration = pendingKnowledgeNarrationRef.current;
                  const followUpWasAnswered = Boolean(answeredFollowUpQuestionIdRef.current);
                  const shouldNarrateKnowledge = shouldNarrateKnowledgeAfterFollowUp(
                    pendingNarration,
                    answeredFollowUpQuestionIdRef.current,
                    knowledgeSpeechClosedRef.current,
                  );
                  if (followUpTimelineIdRef.current) {
                    const timelineId = followUpTimelineIdRef.current;
                    setAgentTimeline((items) => items.map((item) => item.id === timelineId && item.status === 'running'
                      ? { ...item, status: 'done', detail: '课堂追问已关闭。' }
                      : item));
                    followUpTimelineIdRef.current = null;
                  }
                  pendingKnowledgeNarrationRef.current = null;
                  answeredFollowUpQuestionIdRef.current = null;
                  followUpSpeechEpochRef.current += 1;
                  interactionAbortRef.current?.abort();
                  interactionAbortRef.current = null;
                  requestVoiceDeactivation();
                  stopXiaozhiSpeech();
                  globalSpeechActiveRef.current = false;
                  setGlobalSpeechActive(false);
                  setIsXiaozhiSpeaking(false);
                  setIsAgentRunning(false);
                  setIsAgentRequestPending(false);
                  setIsFollowUpPreparing(false);
                  setVoiceListeningLocked(false);
                  setLastFinalVoiceText('');
                  setFollowUpQuestionReady(false);
                  setFollowUpRecognitionState({ phase: 'idle' });
                  setFollowUpQuestion(null);
                  setKnowledgeContent('');
                  setIsKnowledgeStreaming(false);
                  setAgentTimeline([]);
                  setAgentStatuses(AGENT_STATUS_IDLE);
                  setXiaozhiState('idle');
                  setXiaozhiMessage('');
                  setAgentThinking('');
                  setAgentSummary('');
                  if (shouldNarrateKnowledge && pendingNarration) {
                    setAiAnalysis('课堂追问已完成，正在朗读知识讲解。');
                    enqueueKnowledgeSpeech(pendingNarration.text);
                    flushKnowledgeSpeech();
                  } else if (followUpWasAnswered) {
                    finishVoiceTurn(voiceTurnRef.current);
                  }
                }}
              />
            )}
          </AnimatePresence>
        </section>

        {detailPanelVisible && (
          <ModelDetailPanel
            activeTab={detailPanelTab}
            profile={activeModelProfile}
            modelName={fileName || (activeContent === 'biodigital' ? '心脏模型2' : '')}
            content={knowledgeContent}
            isStreaming={isKnowledgeStreaming}
            isNarrating={isKnowledgeNarrating}
            narrationCharIndex={knowledgeNarrationCharIndex}
            structureImage={modelStructureImage}
            structureImageButtonRef={structureImageRef}
            onStructureImageClick={() => {
              if (modelStructureImage) setExpandedStructureImage(modelStructureImage);
            }}
            onTabChange={setDetailPanelTab}
            onClose={() => {
              if (detailPanelTab === 'narration' && showKnowledgePanel) {
                closeKnowledgePanel();
                setDetailPanelTab('info');
                return;
              }
              setDetailPanelOpen(false);
            }}
          />
        )}
      </main>

      <footer
        className="relative z-10 flex h-14 items-center px-7 text-[11px] font-bold tracking-wider text-slate-500 gap-4"
        aria-hidden={isStageAppFullscreen || undefined}
      >
        <span>© 2026 数智课堂 | 教育 AI 实验室</span>
        {activeContent === 'model' && (
          <div className="flex items-center gap-2">
            <VoiceController
              controlRef={controlRef}
              onStatusChange={(msg) => setAiAnalysis(msg)}
              onRecognizedText={(text) => {
                // Follow-up answers must only be judged from a final recognition
                // result. Interim text can briefly look like "A"/"B" and would
                // otherwise submit an answer before the student finishes.
                if (!followUpQuestion) setLastFinalVoiceText(text);
              }}
              onRecognitionStateChange={(state) => {
                if (followUpQuestion) setFollowUpRecognitionState(state);
              }}
              onFinalUtterance={(text) => {
                if (followUpQuestion) {
                  setLastFinalVoiceText(text);
                  return;
                }
                voiceConversationLoopRef.current = true;
                void handleXiaozhiRequest(text);
              }}
              onBargeIn={() => {
                if (followUpQuestion) {
                  return;
                }
                handleVoiceBargeIn();
              }}
              onActiveChange={setXiaozhiVoiceActive}
              onInteractionModeChange={handleInteractionModeChange}
              assistantSpeechText={`${xiaozhiMessage} ${knowledgeContent}`}
              assistantSpeaking={isXiaozhiSpeaking}
              answerOnly={Boolean(followUpQuestion)}
              answerOptions={followUpQuestion?.options}
              activeAnswerQuestionId={followUpQuestion?.id}
              toggleRequest={voiceToggleRequest}
              forceToggleRequest={forceVoiceToggle}
              activateRequest={voiceActivateRequest}
              deactivateRequest={voiceDeactivateRequest}
              disabled={voiceInputDisabled}
              listeningAllowed={!voiceInputDisabled}
            />
          </div>
        )}
      </footer>

    </div>
  );
};

export default App;
