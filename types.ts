
// 模型类型
export interface HandLandmarkPoint {
  x: number;
  y: number;
  z: number;
}

export type HandLandmarks = HandLandmarkPoint[] | null;

export type ModelType = 'glb' | 'gltf' | 'fbx';
export type InteractionMode = 'dual' | 'single';

export enum GestureType {
  NONE = 'NONE',
  RIGHT_PINCH_DRAG = 'RIGHT_PINCH_DRAG', // Right Hand: Pinch -> Drag Position
  LEFT_PINCH_DRAG = 'LEFT_PINCH_DRAG',     // Left Hand: Pinch -> Drag Position
  RIGHT_TWO_FINGER_ROTATE = 'RIGHT_TWO_FINGER_ROTATE', // Right Hand: Index + Middle -> Free 360 Rotation
  ZOOM_IN_PALM = 'ZOOM_IN_PALM', // Left Hand: Thumb/index moving apart, other fingers curled
  ZOOM_OUT_FIST = 'ZOOM_OUT_FIST', // Left Hand: Thumb/index moving together, other fingers curled
  DUAL_HAND_CONTACT = 'DUAL_HAND_CONTACT', // Both Hands: Contact (Hold to show video)
  DUAL_HAND_OPEN_STOP = 'DUAL_HAND_OPEN_STOP',
}

export enum MoveDirection {
  CENTER = 'CENTER',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  UP = 'UP',
  DOWN = 'DOWN'
}

export interface ControlState {
  gesture: GestureType;
  direction: MoveDirection;
  isConnected: boolean;
}

export interface InteractionSettings {
  zoomSpeed: number;     // 0.1 - 5.0, default 0.8
  rotationSpeed: number; // 0.1 - 5.0, default 5.0
}

export interface AgentDisassemblyControl {
  enabled: boolean;
  strength: number;      // 0 - 1, how far parts spread from the center
  spacing: number;       // minimum visual spacing between targets
  avoidOverlap: boolean;
  actionId: number;      // increment to force recalculating target positions
  label: string;
}

// Shared ref object to communicate between React components without re-renders
export interface ControlRefs {
  // Time-normalized angular rate (radians per second before the consumer's
  // interaction-speed multiplier). x = pitch, y = yaw. Consumers must apply
  // this value once with their frame delta; it is not a per-frame increment.
  rotationVelocity: { x: number; y: number };
  rotationGestureActive: boolean; // true only while the camera sees the two-finger rotation pose
  rotationLocked: boolean; // voice lock: blocks any rotation input until unlocked
  voiceRotationActive: boolean; // true = voice spin is running, HandController must NOT overwrite rotationVelocity
  // Time-normalized zoom rate. Consumers apply it once with frame delta.
  zoomSpeed: number;
  panPosition: { x: number; y: number }; // Target position for dragging
  isDragging: boolean;
  // 3D虚拟手数据
  handLandmarks: {
    left: HandLandmarks;
    right: HandLandmarks;
  };
  interactionHandLandmarks: HandLandmarks;
  handNDCPosition: { x: number; y: number } | null;
  // Live webcam MediaStream, published by HandController so other overlays
  // (e.g. the quiz answer-area camera box) can mirror the same feed.
  webcamStream: MediaStream | null;
  // 手势答题指针（相对"空中鼠标"模式算出的光标位置，视口归一化 [0,1]），
  // 由 HandController 每帧写入，QuizOverlay 直接消费，避免重复计算。
  handPointer: { x: number; y: number } | null;
  // 摄像头原始食指尖归一化坐标（未镜像），调试读数 / 自动标定用。
  handRawFingertip: { x: number; y: number } | null;
  interactionSettings: InteractionSettings;
  agentDisassembly: AgentDisassemblyControl;
}

export type TeachingModelId = 'heart' | 'biodigital_heart' | 'hiv' | 'diamond' | 'diamond_unit_cell' | 'pubchem_6233' | 'earth_layers' | 'terrain' | 'nacl' | 'sio2' | 'nitrobenzene' | 'brain' | 'organ_heart' | 'lungs' | 'liver' | 'kidneys' | 'eyeball' | 'intestine' | 'pancreas' | 'skin';
export type AgentRole = 'orchestrator' | 'planner' | 'executor' | 'evaluator' | 'questioner';
export type AgentStatus = 'idle' | 'thinking' | 'running' | 'done' | 'error';

export type AgentToolName =
  | 'load_model'
  | 'auto_rotate'
  | 'auto_zoom'
  | 'explode_model'
  | 'reset_model_layout'
  | 'enable_gesture'
  | 'disable_gesture'
  | 'enter_fullscreen'
  | 'exit_fullscreen'
  | 'switch_sidebar'
  | 'set_teacher_log';

export interface AgentToolCall {
  id: string;
  name: AgentToolName;
  label: string;
  args: Record<string, unknown>;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  narration: string;
  toolCalls: AgentToolCall[];
}

export interface AgentPlan {
  topic: string;
  modelId: TeachingModelId;
  steps: AgentPlanStep[];
  summaryFocus: string[];
}

export interface AgentTimelineItem {
  id: string;
  agent: AgentRole;
  title: string;
  detail: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export type OrchestratorAction =
  | 'teach_demo'
  | 'switch_model'
  | 'answer'
  | 'open_model_generation'
  | 'start_quiz'
  | 'control_model';

export interface OrchestratorDecision {
  action: OrchestratorAction;
  response: string;
  request: string;
  modelId?: TeachingModelId;
  toolCalls?: AgentToolCall[];
}

export interface FollowUpQuestion {
  id: string;
  subject: string;
  question: string;
  options: [string, string];
  correctIndex: 0 | 1;
  explanation: string;
}

export interface FollowUpResult {
  selectedIndex: 0 | 1;
  isCorrect: boolean;
  feedback: string;
}

export type MemoryCategory = 'profile' | 'preference' | 'learned_topic' | 'weak_point' | 'mastery';

export interface ConversationSession {
  id: number;
  title: string;
  summary: string;
  turnCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant' | 'event';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LearningMemory {
  id: number;
  category: MemoryCategory;
  content: string;
  confidence: number;
  sourceSessionId: number | null;
  sourceSummary: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySettings {
  memoryEnabled: boolean;
  noticeSeen: boolean;
}
