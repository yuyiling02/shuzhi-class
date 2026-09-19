import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { CommonClient } from 'tencentcloud-sdk-nodejs-common';
import {
  build3dSubmissionDescription,
  buildActivityLogDescription,
  buildSemanticActivityLog,
  buildLogPagination,
  createActivityLogMiddleware,
  initializeActivityLog,
  normalizeLogPagination,
  parsePositiveInteger,
  resolveRequestIp,
  resolveTrustProxySetting,
  updateLastAccess,
  validateOptionalSchool,
} from './activityLog.js';
import { initializeLearningMemory, registerLearningMemoryRoutes, startLearningMemoryJobs } from './learningMemory.js';
import { initializeQuizWrongBook, registerQuizWrongBookRoutes } from './quizWrongBook.js';
import { applyOrganResourceSeed } from './resourceLibrarySeeds.js';
import {
  hasFeedbackContent,
  normalizeFeedback,
  validateFeedbackAttachments,
} from './feedback.js';
import { attachVolcTtsWebSocketServer, createVolcTtsService } from './volcTts.js';

dotenv.config();
dotenv.config({ path: '.env.local', override: false });
dotenv.config({ path: 'env.local', override: true });

const app = express();
const httpServer = createServer(app);

const PORT = Number(process.env.API_PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-deploying';
const COOKIE_NAME = 'hs_auth';
const isProduction = process.env.NODE_ENV === 'production';
const TRUST_PROXY = resolveTrustProxySetting(process.env.TRUST_PROXY_HOPS, isProduction);
const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RESOURCE_MODEL_STORAGE_DIRECTORY = path.resolve(
  process.env.RESOURCE_MODEL_STORAGE_DIR || path.join(SERVER_DIRECTORY, 'storage', 'resource-models'),
);
const FEEDBACK_ATTACHMENT_STORAGE_DIRECTORY = path.resolve(
  process.env.FEEDBACK_ATTACHMENT_STORAGE_DIR || path.join(SERVER_DIRECTORY, 'storage', 'feedback-attachments'),
);
const MAX_FEEDBACK_UPLOAD_SIZE = 16 * 1024 * 1024;
const MAX_RESOURCE_FILE_SIZE = 200 * 1024 * 1024;
const MAX_RESOURCE_UPLOAD_SIZE = 260 * 1024 * 1024;
const RESOURCE_MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.fbx']);
const RESOURCE_ASSET_EXTENSIONS = new Set([
  ...RESOURCE_MODEL_EXTENSIONS,
  '.bin', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tga', '.ktx', '.ktx2', '.dds',
]);
const RESOURCE_ICON_KEYS = new Set(['box', 'flask', 'heart', 'globe', 'atom']);
const DEFAULT_THEME_ID = 'classic-blue';
const THEME_IDS = new Set([
  DEFAULT_THEME_ID,
  'tech-blue',
  'dream-pink',
  'forest-green',
  'violet',
  'sunset-orange',
  'golden',
  'cherry-rose',
]);

app.set('trust proxy', TRUST_PROXY);

const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'huishi_classroom',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
};

function describeDatabaseTarget() {
  return `${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;
}

function explainStartupError(error) {
  if (error?.code === 'ER_ACCESS_DENIED_ERROR') {
    return [
      `MySQL 拒绝了当前连接：${describeDatabaseTarget()}`,
      '请检查项目根目录 .env.local 里的 MYSQL_USER 和 MYSQL_PASSWORD 是否与本机 MySQL 一致。',
      '如果你刚下载/导入了数据库，也请确认 MYSQL_DATABASE 是实际导入的库名。',
    ].join('\n');
  }

  if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOTFOUND') {
    return [
      `无法连接 MySQL：${describeDatabaseTarget()}`,
      '请确认 MySQL 已启动，并且 MYSQL_HOST / MYSQL_PORT 配置正确。',
    ].join('\n');
  }

  return error;
}

if (!/^[a-zA-Z0-9_$-]+$/.test(dbConfig.database)) {
  throw new Error('MYSQL_DATABASE may only contain letters, numbers, underscore, dollar sign, or dash.');
}

let pool;

app.use(cors({
  origin: CLIENT_ORIGIN,
  credentials: true,
}));
app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(createActivityLogMiddleware({ getPool: () => pool }));

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
};
const clearCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  path: '/',
};

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    avatarUrl: user.avatar_data_url || '',
    school: user.school ?? null,
    lastAccessAt: user.last_access_at ?? null,
    lastAccessIp: user.last_access_ip ?? null,
    theme: THEME_IDS.has(user.theme) ? user.theme : DEFAULT_THEME_ID,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  };
}

function applyCurrentAccessMetadata(req, user) {
  if (!user) return user;
  user.last_access_at = new Date();
  user.last_access_ip = resolveRequestIp(req);
  return user;
}

async function persistCurrentAccessMetadata(req, user) {
  const currentUser = applyCurrentAccessMetadata(req, user);
  if (!currentUser) return currentUser;

  await updateLastAccess(pool, {
    userId: currentUser.id,
    ipAddress: currentUser.last_access_ip,
  });
  // The audit middleware runs after the response. Mark this request so the
  // metadata has already been saved before a following admin-list request.
  req.accessMetadataPersisted = true;
  return currentUser;
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function isValidUsername(username) {
  if (typeof username !== 'string') return false;

  const value = username.trim();
  const plainUsername = /^[a-zA-Z0-9_\u4e00-\u9fa5-]{3,32}$/;
  const emailUsername = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return plainUsername.test(value) || (value.length <= 64 && emailUsername.test(value));
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

function isValidDisplayName(displayName) {
  return typeof displayName === 'string' && displayName.trim().length >= 1 && displayName.trim().length <= 32;
}

function normalizeAvatarUrl(avatarUrl) {
  if (avatarUrl === undefined) return undefined;
  if (avatarUrl === null || avatarUrl === '') return '';
  if (typeof avatarUrl !== 'string') return null;
  if (avatarUrl.length > 650_000) return null;
  if (!/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(avatarUrl)) return null;

  const base64 = avatarUrl.split(',')[1] || '';
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > 480_000) return null;

  return avatarUrl;
}

async function findUserByUsername(username) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE username = :username LIMIT 1',
    { username },
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE id = :id LIMIT 1',
    { id },
  );
  return rows[0] || null;
}

async function countActiveAdmins() {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM users WHERE role = "admin" AND status = "active"',
  );
  return Number(rows[0]?.count || 0);
}

async function wouldRemoveLastActiveAdmin(user) {
  return user?.role === 'admin' && user.status === 'active' && await countActiveAdmins() <= 1;
}

async function ensureUsersColumn(name, definition) {
  const [columns] = await pool.query('SHOW COLUMNS FROM users LIKE ?', [name]);
  if (columns.length === 0) {
    await pool.query(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

async function ensureUsersThemeColumn() {
  const [columns] = await pool.query("SHOW COLUMNS FROM users LIKE 'theme'");
  if (columns.length === 0) {
    await pool.query("ALTER TABLE users ADD COLUMN theme VARCHAR(24) NOT NULL DEFAULT 'classic-blue' AFTER last_access_ip");
    return;
  }

  if (columns[0].Default !== DEFAULT_THEME_ID) {
    await pool.query("ALTER TABLE users ALTER COLUMN theme SET DEFAULT 'classic-blue'");
  }
}

async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: '未登录' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.id);

    if (!user || user.status !== 'active') {
      res.clearCookie(COOKIE_NAME, clearCookieOptions);
      return res.status(401).json({ message: '账号不可用，请重新登录' });
    }

    req.user = await persistCurrentAccessMetadata(req, user);
    return next();
  } catch {
    res.clearCookie(COOKIE_NAME, clearCookieOptions);
    return res.status(401).json({ message: '登录已过期' });
  }
}

async function findOptionalAuthenticatedUser(req) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.id);
    return user?.status === 'active' ? user : null;
  } catch {
    return null;
  }
}

function parseCookieHeader(header = '') {
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) return [];
    try {
      return [[key, decodeURIComponent(value)]];
    } catch {
      return [[key, value]];
    }
  }));
}

async function authenticateWebSocketRequest(req) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(payload.id);
    return user?.status === 'active' ? user : null;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: '需要管理员权限' });
  }

  return next();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeResourceName(value, label = '名称') {
  const name = String(value || '').trim();
  if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw httpError(400, `${label}需为 1-64 个字符`);
  }
  return name;
}

function normalizeResourceIcon(value) {
  const iconKey = String(value || 'box').trim().toLowerCase();
  return RESOURCE_ICON_KEYS.has(iconKey) ? iconKey : 'box';
}

function normalizeResourceTagName(value) {
  const name = normalizeResourceName(value, '标签名称');
  if (name === '我的模型') {
    throw httpError(409, '“我的模型”是浏览器本地固定标签');
  }
  return name;
}

function normalizeUploadFileName(value) {
  const fileName = path.basename(String(value || '').replaceAll('\\', '/')).normalize('NFC').trim();
  if (!fileName || fileName.length > 180 || /[\u0000-\u001f\u007f]/.test(fileName)) {
    throw httpError(400, '模型文件名无效或过长');
  }
  return fileName;
}

function resourceFileUrl(modelId, fileId) {
  return `/api/resource-models/${modelId}/files/${fileId}`;
}

async function loadResourceLibrary() {
  const [tagRows] = await pool.execute(
    'SELECT id, name, icon_key, sort_order, created_at, updated_at FROM resource_tags ORDER BY sort_order ASC, id ASC',
  );
  const [modelRows] = await pool.execute(
    `SELECT id, tag_id, name, model_type, source_kind, source_url, seed_key, file_size, sort_order, created_at, updated_at
     FROM resource_models
     ORDER BY sort_order ASC, id ASC`,
  );
  const [fileRows] = await pool.execute(
    `SELECT id, model_id, original_name, storage_name, mime_type, file_size, is_primary
     FROM resource_model_files
     ORDER BY is_primary DESC, id ASC`,
  );

  const filesByModel = new Map();
  fileRows.forEach((file) => {
    const modelId = Number(file.model_id);
    const files = filesByModel.get(modelId) || [];
    files.push(file);
    filesByModel.set(modelId, files);
  });

  const modelsByTag = new Map();
  modelRows.forEach((model) => {
    const id = Number(model.id);
    const tagId = Number(model.tag_id);
    const files = filesByModel.get(id) || [];
    const primaryFile = files.find((file) => Boolean(file.is_primary));
    const assets = {};

    files.forEach((file) => {
      const url = resourceFileUrl(id, Number(file.id));
      assets[file.original_name] = url;
      assets[String(file.original_name).toLowerCase()] = url;
    });

    const serialized = {
      id,
      tagId,
      seedKey: model.seed_key || null,
      name: model.name,
      type: model.model_type,
      sourceKind: model.source_kind,
      url: model.source_kind === 'builtin'
        ? model.source_url
        : primaryFile
          ? resourceFileUrl(id, Number(primaryFile.id))
          : '',
      assets,
      size: Number(model.file_size || 0),
      sortOrder: Number(model.sort_order || 0),
      createdAt: model.created_at,
      updatedAt: model.updated_at,
    };
    const models = modelsByTag.get(tagId) || [];
    models.push(serialized);
    modelsByTag.set(tagId, models);
  });

  return tagRows.map((tag) => ({
    id: Number(tag.id),
    name: tag.name,
    iconKey: tag.icon_key,
    sortOrder: Number(tag.sort_order || 0),
    createdAt: tag.created_at,
    updatedAt: tag.updated_at,
    models: modelsByTag.get(Number(tag.id)) || [],
  }));
}

async function findResourceTagById(id) {
  const [rows] = await pool.execute('SELECT * FROM resource_tags WHERE id = :id LIMIT 1', { id });
  return rows[0] || null;
}

async function findResourceModelById(id) {
  const [rows] = await pool.execute('SELECT * FROM resource_models WHERE id = :id LIMIT 1', { id });
  return rows[0] || null;
}

async function serializedResourceModel(id) {
  const tags = await loadResourceLibrary();
  return tags.flatMap((tag) => tag.models).find((model) => model.id === id) || null;
}

async function parseResourceUpload(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data')) {
    throw httpError(415, '请使用表单上传模型文件');
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_RESOURCE_UPLOAD_SIZE) {
    throw httpError(413, '模型及附件总大小不能超过 260MB');
  }

  let formData;
  try {
    const request = new Request('http://localhost/resource-model-upload', {
      method: 'POST',
      headers: {
        'content-type': String(req.headers['content-type']),
        ...(contentLength > 0 ? { 'content-length': String(contentLength) } : {}),
      },
      body: Readable.toWeb(req),
      duplex: 'half',
    });
    formData = await request.formData();
  } catch {
    throw httpError(400, '模型上传表单无法解析');
  }

  const files = formData.getAll('files').filter(
    (value) => typeof value !== 'string' && typeof value?.arrayBuffer === 'function',
  );
  if (files.length === 0) throw httpError(400, '请选择模型文件');
  if (files.length > 64) throw httpError(400, '一次最多上传 64 个模型及附件文件');

  const normalizedFiles = files.map((file) => {
    const originalName = normalizeUploadFileName(file.name);
    const extension = path.extname(originalName).toLowerCase();
    if (!RESOURCE_ASSET_EXTENSIONS.has(extension)) {
      throw httpError(400, `不支持的模型附件格式：${originalName}`);
    }
    if (file.size <= 0) throw httpError(400, `文件内容为空：${originalName}`);
    if (file.size > MAX_RESOURCE_FILE_SIZE) {
      throw httpError(413, `单个文件不能超过 200MB：${originalName}`);
    }
    return { file, originalName, extension };
  });

  const duplicateNames = new Set();
  normalizedFiles.forEach(({ originalName }) => {
    const key = originalName.toLowerCase();
    if (duplicateNames.has(key)) throw httpError(400, `存在同名附件：${originalName}`);
    duplicateNames.add(key);
  });

  const totalSize = normalizedFiles.reduce((total, item) => total + Number(item.file.size || 0), 0);
  if (totalSize > MAX_RESOURCE_UPLOAD_SIZE) {
    throw httpError(413, '模型及附件总大小不能超过 260MB');
  }

  const requestedPrimaryName = normalizeUploadFileName(formData.get('primaryFileName'));
  const modelFiles = normalizedFiles.filter(({ extension }) => RESOURCE_MODEL_EXTENSIONS.has(extension));
  if (modelFiles.length > 1) {
    throw httpError(400, '一次只能添加一个主模型，其余文件应为纹理或二进制附件');
  }
  const primaryFile = normalizedFiles.find(
    ({ originalName }) => originalName.toLowerCase() === requestedPrimaryName.toLowerCase(),
  );
  if (!primaryFile || !RESOURCE_MODEL_EXTENSIONS.has(primaryFile.extension)) {
    throw httpError(400, '请选择有效的 GLB、GLTF 或 FBX 主模型文件');
  }

  return {
    tagId: Number(formData.get('tagId')),
    name: normalizeResourceName(formData.get('name'), '模型名称'),
    primaryFile,
    files: normalizedFiles,
    totalSize,
  };
}

async function parseFeedbackRequest(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    return { body: req.body || {}, files: [] };
  }
  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > MAX_FEEDBACK_UPLOAD_SIZE) {
    throw httpError(413, '反馈附件总大小不能超过 16MB');
  }

  let formData;
  try {
    const request = new Request('http://localhost/feedback', {
      method: 'POST',
      headers: { 'content-type': String(req.headers['content-type']) },
      body: Readable.toWeb(req),
      duplex: 'half',
    });
    formData = await request.formData();
  } catch {
    throw httpError(400, '反馈表单无法解析');
  }

  let body = {};
  const payload = formData.get('payload');
  if (typeof payload === 'string' && payload.trim()) {
    try { body = JSON.parse(payload); } catch { throw httpError(400, '反馈数据格式无效'); }
  } else {
    for (const key of ['content', 'rating', 'scene', 'sceneOther', 'features', 'voiceAccuracy', 'modelClarity']) {
      const value = formData.get(key);
      if (value !== null) body[key] = value;
    }
    if (typeof body.rating === 'string') body.rating = Number(body.rating);
    if (typeof body.features === 'string') {
      try { body.features = JSON.parse(body.features); } catch { body.features = []; }
    }
  }

  const files = formData.getAll('attachments').filter(
    (value) => typeof value !== 'string' && typeof value?.arrayBuffer === 'function',
  );
  validateFeedbackAttachments(files);
  return { body, files };
}

async function removeStoredResourceFiles(storageNames) {
  await Promise.all(storageNames.map(async (storageName) => {
    try {
      await unlink(path.join(RESOURCE_MODEL_STORAGE_DIRECTORY, path.basename(storageName)));
    } catch (error) {
      if (error?.code !== 'ENOENT') console.error('Resource model file cleanup failed:', error);
    }
  }));
}

async function initializeResourceLibrary() {
  await mkdir(RESOURCE_MODEL_STORAGE_DIRECTORY, { recursive: true });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      meta_key VARCHAR(128) NOT NULL,
      meta_value TEXT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (meta_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS resource_tags (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(64) NOT NULL,
      icon_key VARCHAR(32) NOT NULL DEFAULT 'box',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY resource_tags_name_unique (name),
      KEY resource_tags_sort_index (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS resource_models (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tag_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(64) NOT NULL,
      model_type ENUM('glb', 'gltf', 'fbx') NOT NULL,
      source_kind ENUM('builtin', 'upload') NOT NULL DEFAULT 'upload',
      source_url VARCHAR(1024) NULL,
      seed_key VARCHAR(64) NULL,
      file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY resource_models_seed_key_unique (seed_key),
      KEY resource_models_tag_sort_index (tag_id, sort_order),
      CONSTRAINT resource_models_tag_fk FOREIGN KEY (tag_id) REFERENCES resource_tags(id) ON DELETE RESTRICT,
      CONSTRAINT resource_models_creator_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS resource_model_files (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      model_id BIGINT UNSIGNED NOT NULL,
      original_name VARCHAR(180) NOT NULL,
      storage_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(128) NULL,
      file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      is_primary TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY resource_model_files_storage_unique (storage_name),
      KEY resource_model_files_model_index (model_id),
      CONSTRAINT resource_model_files_model_fk FOREIGN KEY (model_id) REFERENCES resource_models(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [seedRows] = await pool.execute(
    'SELECT meta_key FROM app_metadata WHERE meta_key = "resource_library_seed_v1" LIMIT 1',
  );
  if (seedRows.length === 0) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const defaultTags = [
        { name: '化学', iconKey: 'flask', sortOrder: 10 },
        { name: '生物', iconKey: 'heart', sortOrder: 20 },
        { name: '地理', iconKey: 'globe', sortOrder: 30 },
      ];
      const tagIds = new Map();

      for (const tag of defaultTags) {
        await connection.execute(
          `INSERT INTO resource_tags (name, icon_key, sort_order)
           VALUES (:name, :iconKey, :sortOrder)
           ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
          tag,
        );
        const [rows] = await connection.execute(
          'SELECT id FROM resource_tags WHERE name = :name LIMIT 1',
          { name: tag.name },
        );
        tagIds.set(tag.name, Number(rows[0].id));
      }

      const defaultModels = [
        { seedKey: 'chem-diamond', tag: '化学', name: '金刚石模型', url: '/models/diamond.glb', sortOrder: 10 },
        { seedKey: 'chem-diamond-cell', tag: '化学', name: '金刚石晶胞', url: '/models/diamond-unit-cell_NIH3D.glb', sortOrder: 20 },
        { seedKey: 'chem-dichlorotoluene', tag: '化学', name: '1,4-二氯甲基苯', url: '/models/pubchem-6233-bas-color-print_NIH3D.glb', sortOrder: 30 },
        { seedKey: 'chem-nitrobenzene', tag: '化学', name: '硝基苯', url: '/models/7416-bas-color-print_NIH3D.glb', sortOrder: 40 },
        { seedKey: 'bio-heart', tag: '生物', name: '心脏模型', url: '/models/heart-optimized.glb', sortOrder: 10 },
        { seedKey: 'bio-hiv', tag: '生物', name: 'HIV 病毒模型', url: '/models/hiv-virus.glb', sortOrder: 20 },
        { seedKey: 'geo-earth-layers', tag: '地理', name: '地球内部结构', url: '/models/earth-layers.glb', sortOrder: 10 },
        { seedKey: 'geo-terrain', tag: '地理', name: '地形地貌总览', url: '/models/terrain-topography.glb', sortOrder: 20 },
      ];

      for (const model of defaultModels) {
        await connection.execute(
          `INSERT IGNORE INTO resource_models
            (tag_id, name, model_type, source_kind, source_url, seed_key, sort_order)
           VALUES (:tagId, :name, 'glb', 'builtin', :url, :seedKey, :sortOrder)`,
          { ...model, tagId: tagIds.get(model.tag) },
        );
      }

      await connection.execute(
        'INSERT IGNORE INTO app_metadata (meta_key, meta_value) VALUES ("resource_library_seed_v1", "1")',
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  await pool.execute('UPDATE resource_models SET name = "心脏模型" WHERE seed_key = "bio-heart"');

  const [organSeedRows] = await pool.execute(
    'SELECT meta_key FROM app_metadata WHERE meta_key = "resource_library_seed_v2_organs" LIMIT 1',
  );
  if (organSeedRows.length === 0) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await applyOrganResourceSeed(connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function initializeDatabase() {
  const bootstrapConnection = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  await bootstrapConnection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await bootstrapConnection.end();

  pool = mysql.createPool(dbConfig);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(64) NOT NULL,
      school VARCHAR(128) NULL,
      display_name VARCHAR(64) NULL,
      avatar_data_url MEDIUMTEXT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
      status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_access_at DATETIME NULL,
      last_access_ip VARCHAR(45) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY users_username_unique (username),
      KEY users_role_index (role),
      KEY users_status_index (status),
      KEY users_last_access_index (last_access_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY user_feedback_user_index (user_id),
      CONSTRAINT user_feedback_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_attachments (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      feedback_id BIGINT UNSIGNED NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      storage_name VARCHAR(96) NOT NULL,
      mime_type VARCHAR(64) NOT NULL,
      size BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY feedback_attachments_storage_unique (storage_name),
      KEY feedback_attachments_feedback_index (feedback_id),
      CONSTRAINT feedback_attachments_feedback_fk FOREIGN KEY (feedback_id) REFERENCES user_feedback(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await mkdir(FEEDBACK_ATTACHMENT_STORAGE_DIRECTORY, { recursive: true });

  await ensureUsersColumn('school', 'VARCHAR(128) NULL AFTER username');
  await ensureUsersColumn('display_name', 'VARCHAR(64) NULL AFTER username');
  await ensureUsersColumn('avatar_data_url', 'MEDIUMTEXT NULL AFTER display_name');
  await ensureUsersColumn('last_access_at', 'DATETIME NULL AFTER updated_at');
  await ensureUsersColumn('last_access_ip', 'VARCHAR(45) NULL AFTER last_access_at');
  await ensureUsersThemeColumn();

  await initializeActivityLog(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_voice_preferences (
      user_id BIGINT UNSIGNED NOT NULL,
      mode ENUM('system', 'volcengine') NOT NULL DEFAULT 'system',
      system_voice_uri VARCHAR(512) NULL,
      provider_voice_id VARCHAR(128) NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT user_voice_preferences_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await initializeResourceLibrary();
  await initializeLearningMemory(pool);
  await initializeQuizWrongBook(pool);

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123456';
  const [admins] = await pool.execute('SELECT id FROM users WHERE role = "admin" LIMIT 1');

  if (admins.length === 0) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const seedUser = await findUserByUsername(adminUsername);

    if (seedUser) {
      await pool.execute(
        'UPDATE users SET password_hash = :passwordHash, display_name = COALESCE(NULLIF(display_name, ""), username), role = "admin", status = "active" WHERE id = :id',
        { id: seedUser.id, passwordHash },
      );
    } else {
      await pool.execute(
        'INSERT INTO users (username, display_name, password_hash, role, status) VALUES (:username, :username, :passwordHash, "admin", "active")',
        { username: adminUsername, passwordHash },
      );
    }

    console.log(`Default admin created: ${adminUsername}`);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

registerLearningMemoryRoutes(app, {
  getPool: () => pool,
  requireAuth,
});

registerQuizWrongBookRoutes(app, {
  getPool: () => pool,
  requireAuth,
});

app.post('/api/activity-events', requireAuth, (req, res) => {
  try {
    const event = buildSemanticActivityLog(req.body);
    req.activityLogAction = event.action;
    req.activityLogDescription = event.description;
    return res.status(204).end();
  } catch (error) {
    if (error?.code === 'INVALID_ACTIVITY_EVENT') {
      return res.status(400).json({ message: error.message });
    }
    throw error;
  }
});

app.post('/api/auth/register', async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const schoolValidation = validateOptionalSchool(body.school);

  if (!isValidUsername(username)) {
    return res.status(400).json({ message: '用户名可使用中文、字母、数字、下划线、短横线，或邮箱地址' });
  }

  if (!isValidPassword(password)) {
    return res.status(400).json({ message: '密码需为 6-128 位' });
  }

  if (!schoolValidation.valid) {
    return res.status(400).json({ message: schoolValidation.message });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      'INSERT INTO users (username, school, display_name, password_hash, role, status) VALUES (:username, :school, :username, :passwordHash, "user", "active")',
      { username, school: schoolValidation.value, passwordHash },
    );
    const defaultVoice = defaultVoicePreference(volcTtsService);
    await pool.execute(
      `INSERT INTO user_voice_preferences (user_id, mode, system_voice_uri, provider_voice_id)
       VALUES (:userId, :mode, :systemVoiceUri, :providerVoiceId)`,
      { userId: result.insertId, ...defaultVoice },
    );
    const user = await persistCurrentAccessMetadata(req, await findUserById(result.insertId));
    req.activityLogUser = user;
    res.cookie(COOKIE_NAME, signUser(user), cookieOptions);
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: '用户名已存在' });
    }

    console.error('Register failed:', error);
    return res.status(500).json({ message: '注册失败，请稍后重试' });
  }
});

async function loginWithRole(req, res, expectedRole) {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (!username || !password) {
    return res.status(400).json({ message: '请输入用户名和密码' });
  }

  try {
    const user = await findUserByUsername(username);
    const passwordMatches = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!user || !passwordMatches || user.role !== expectedRole) {
      return res.status(401).json({ message: '用户名或密码错误' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ message: '账号已被禁用' });
    }

    await persistCurrentAccessMetadata(req, user);
    req.activityLogUser = user;
    // session-only cookie：关闭浏览器后过期，每次都需要重新登录
    res.cookie(COOKIE_NAME, signUser(user), { ...cookieOptions, maxAge: undefined });
    return res.json({ user: publicUser(user) });
  } catch (error) {
    console.error('Login failed:', error);
    return res.status(500).json({ message: '登录失败，请稍后重试' });
  }
}

app.post('/api/auth/login', (req, res) => loginWithRole(req, res, 'user'));
app.post('/api/auth/admin/login', (req, res) => loginWithRole(req, res, 'admin'));

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/auth/logout', async (req, res) => {
  req.activityLogLogAnonymous = true;
  req.activityLogUser = await findOptionalAuthenticatedUser(req);
  if (req.activityLogUser) await persistCurrentAccessMetadata(req, req.activityLogUser);
  res.clearCookie(COOKIE_NAME, clearCookieOptions);
  res.json({ ok: true });
});

app.patch('/api/profile', requireAuth, async (req, res) => {
  const displayName = req.body.displayName === undefined ? undefined : String(req.body.displayName || '').trim();
  const avatarUrl = normalizeAvatarUrl(req.body.avatarUrl);

  if (displayName !== undefined && !isValidDisplayName(displayName)) {
    return res.status(400).json({ message: '昵称需为 1-32 个字符' });
  }

  if (avatarUrl === null) {
    return res.status(400).json({ message: '头像需为 PNG、JPEG 或 WebP 图片，且体积不能过大' });
  }

  if (displayName === undefined && avatarUrl === undefined) {
    return res.status(400).json({ message: '请提供要更新的个人资料' });
  }

  const updates = [];
  const values = { id: req.user.id };

  if (displayName !== undefined) {
    updates.push('display_name = :displayName');
    values.displayName = displayName;
  }

  if (avatarUrl !== undefined) {
    updates.push('avatar_data_url = :avatarUrl');
    values.avatarUrl = avatarUrl;
  }

  await pool.execute(
    `UPDATE users SET ${updates.join(', ')} WHERE id = :id`,
    values,
  );

  const updated = await findUserById(req.user.id);
  return res.json({ user: publicUser(updated) });
});

app.patch('/api/profile/password', requireAuth, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

  if (!currentPassword) {
    return res.status(400).json({ message: '请输入当前密码' });
  }

  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ message: '新密码需为 6-128 位' });
  }

  try {
    const user = await findUserById(req.user.id);
    const passwordMatches = user ? await bcrypt.compare(currentPassword, user.password_hash) : false;

    if (!passwordMatches) {
      return res.status(400).json({ message: '当前密码错误' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ message: '新密码不能与当前密码相同' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.execute(
      'UPDATE users SET password_hash = :passwordHash WHERE id = :id',
      { id: req.user.id, passwordHash },
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error('Password update failed:', error);
    return res.status(500).json({ message: '密码修改失败，请稍后重试' });
  }
});

app.post('/api/feedback', requireAuth, async (req, res, next) => {
  const storedNames = [];
  let connection;
  try {
    const parsed = await parseFeedbackRequest(req);
    const structured = normalizeFeedback(parsed.body);
    if (!hasFeedbackContent(structured, parsed.files.length)) {
      throw httpError(400, '至少填写一项反馈');
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO user_feedback (user_id, content) VALUES (:userId, :content)',
      { userId: req.user.id, content: JSON.stringify(structured) },
    );
    const feedbackId = Number(result.insertId);
    for (const file of parsed.files) {
      const extension = file.type === 'image/png' ? '.png' : file.type === 'image/webp' ? '.webp' : '.jpg';
      const storageName = `${randomUUID()}${extension}`;
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(path.join(FEEDBACK_ATTACHMENT_STORAGE_DIRECTORY, storageName), buffer, { flag: 'wx' });
      storedNames.push(storageName);
      await connection.execute(
        `INSERT INTO feedback_attachments
          (feedback_id, original_name, storage_name, mime_type, size)
         VALUES (:feedbackId, :originalName, :storageName, :mimeType, :size)`,
        {
          feedbackId,
          originalName: normalizeUploadFileName(file.name || 'feedback-image'),
          storageName,
          mimeType: file.type,
          size: buffer.length,
        },
      );
    }
    await connection.commit();
    return res.status(201).json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    await Promise.all(storedNames.map((name) => unlink(path.join(FEEDBACK_ATTACHMENT_STORAGE_DIRECTORY, name)).catch(() => {})));
    if (error?.status) return res.status(error.status).json({ message: error.message });
    return next(error);
  } finally {
    connection?.release();
  }
});

app.get('/api/feedback-attachments/:id', requireAuth, async (req, res, next) => {
  try {
    const id = parsePositiveInteger(req.params.id, null);
    if (!id) return res.status(400).json({ message: '无效的附件 ID' });
    const [rows] = await pool.execute(
      `SELECT a.*, f.user_id
       FROM feedback_attachments a
       INNER JOIN user_feedback f ON f.id = a.feedback_id
       WHERE a.id = :id LIMIT 1`,
      { id },
    );
    const attachment = rows[0];
    if (!attachment) return res.status(404).json({ message: '反馈附件不存在' });
    if (req.user.role !== 'admin' && Number(attachment.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ message: '无权访问该反馈附件' });
    }
    const filePath = path.join(FEEDBACK_ATTACHMENT_STORAGE_DIRECTORY, attachment.storage_name);
    res.setHeader('Content-Type', attachment.mime_type);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`);
    return res.sendFile(filePath, { dotfiles: 'deny', maxAge: 0 }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    return next(error);
  }
});

const normalizeVoicePreference = (body, service) => {
  const mode = body.mode === 'volcengine' ? 'volcengine' : 'system';
  const systemVoiceUri = typeof body.systemVoiceUri === 'string' ? body.systemVoiceUri.slice(0, 512) : null;
  const providerVoiceId = typeof body.providerVoiceId === 'string' ? body.providerVoiceId.slice(0, 128) : null;
  if (mode === 'volcengine' && (!service.enabled || !service.speakers.some((speaker) => speaker.id === providerVoiceId))) {
    throw httpError(400, '所选真人音色当前不可用');
  }
  return { mode, systemVoiceUri: mode === 'system' ? systemVoiceUri : null, providerVoiceId: mode === 'volcengine' ? providerVoiceId : null };
};

const defaultVoicePreference = (service) => service.enabled && service.defaultSpeaker
  ? { mode: 'volcengine', systemVoiceUri: '', providerVoiceId: service.defaultSpeaker }
  : { mode: 'system', systemVoiceUri: '', providerVoiceId: '' };

const readVoicePreference = async (userId) => {
  await pool.execute('INSERT IGNORE INTO user_voice_preferences (user_id) VALUES (:userId)', { userId });
  const [rows] = await pool.execute('SELECT mode, system_voice_uri, provider_voice_id FROM user_voice_preferences WHERE user_id = :userId', { userId });
  const row = rows[0];
  const providerVoiceId = row?.provider_voice_id || '';
  const providerAvailable = volcTtsService.enabled
    && volcTtsService.speakers.some((speaker) => speaker.id === providerVoiceId);
  if (row?.mode === 'volcengine' && !providerAvailable) {
    return { mode: 'system', systemVoiceUri: '', providerVoiceId: '' };
  }
  return {
    mode: row?.mode === 'volcengine' ? 'volcengine' : 'system',
    systemVoiceUri: row?.system_voice_uri || '',
    providerVoiceId,
  };
};

app.get('/api/voice/preferences', requireAuth, async (req, res) => {
  const preference = await readVoicePreference(req.user.id);
  res.json({ preference, provider: { available: volcTtsService.enabled, voices: volcTtsService.speakers } });
});

app.patch('/api/voice/preferences', requireAuth, async (req, res) => {
  const preference = normalizeVoicePreference(req.body || {}, volcTtsService);
  await pool.execute(
    `INSERT INTO user_voice_preferences (user_id, mode, system_voice_uri, provider_voice_id)
     VALUES (:userId, :mode, :systemVoiceUri, :providerVoiceId)
     ON DUPLICATE KEY UPDATE mode = VALUES(mode), system_voice_uri = VALUES(system_voice_uri), provider_voice_id = VALUES(provider_voice_id)`,
    { userId: req.user.id, ...preference },
  );
  res.json({ preference });
});

app.get('/api/theme', requireAuth, (req, res) => {
  const theme = THEME_IDS.has(req.user.theme) ? req.user.theme : DEFAULT_THEME_ID;
  res.json({ theme });
});

app.patch('/api/theme', requireAuth, async (req, res) => {
  const theme = typeof req.body?.theme === 'string' && THEME_IDS.has(req.body.theme) ? req.body.theme : null;
  if (!theme) return res.status(400).json({ message: '无效的主题' });
  await pool.execute('UPDATE users SET theme = :theme WHERE id = :id', { theme, id: req.user.id });
  res.json({ theme });
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, username, school, display_name, avatar_data_url, role, status,
            created_at, updated_at, last_access_at, last_access_ip
     FROM users
     ORDER BY created_at DESC`,
  );
  res.json({ users: rows.map(publicUser) });
});

app.get('/api/admin/logs', requireAuth, requireAdmin, async (req, res) => {
  const rawUserId = req.query.userId;
  let userId = null;
  if (rawUserId !== undefined && !(typeof rawUserId === 'string' && rawUserId.trim() === '')) {
    userId = parsePositiveInteger(rawUserId, null);
    if (!userId) return res.status(400).json({ message: '无效的用户 ID' });
  }

  const { page, pageSize, offset } = normalizeLogPagination(req.query.page, req.query.pageSize);
  const whereClause = userId === null ? '' : ' WHERE user_id = :userId';
  const queryValues = userId === null ? {} : { userId };
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM activity_logs${whereClause}`,
    queryValues,
  );
  const total = Number(countRows[0]?.total || 0);
  const [rows] = await pool.execute(
    `SELECT id, user_id, username_snapshot, action, description, method, path, status_code,
            ip_address, user_agent, created_at
     FROM activity_logs${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    queryValues,
  );

  return res.json({
    logs: rows.map((row) => ({
      id: Number(row.id),
      userId: row.user_id === null ? null : Number(row.user_id),
      usernameSnapshot: row.username_snapshot || null,
      action: row.action,
      description: row.description || buildActivityLogDescription({
        action: row.action,
        method: row.method,
        path: row.path,
        statusCode: row.status_code,
      }),
      method: row.method,
      path: row.path,
      statusCode: row.status_code === null ? null : Number(row.status_code),
      ipAddress: row.ip_address || null,
      userAgent: row.user_agent || null,
      createdAt: row.created_at,
    })),
    pagination: buildLogPagination({ page, pageSize, total }),
  });
});

// ---- 反馈管理 ----
app.get('/api/admin/feedback', requireAuth, requireAdmin, async (req, res) => {
  const rawUserId = req.query.userId;
  let userId = null;
  if (rawUserId !== undefined && !(typeof rawUserId === 'string' && rawUserId.trim() === '')) {
    userId = parsePositiveInteger(rawUserId, null);
    if (!userId) return res.status(400).json({ message: '无效的用户 ID' });
  }

  const rawPage = Number(req.query.page) || 1;
  const page = Math.max(1, Math.min(rawPage, 1000));
  const rawPageSize = Number(req.query.pageSize) || 20;
  const pageSize = Math.max(5, Math.min(rawPageSize, 100));
  const offset = (page - 1) * pageSize;

  const whereClause = userId === null ? '' : ' WHERE f.user_id = :userId';
  const queryValues = userId === null ? {} : { userId };

  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM user_feedback f${whereClause}`,
    queryValues,
  );
  const total = Number(countRows[0]?.total || 0);

  const [rows] = await pool.execute(
    `SELECT f.id, f.content, f.created_at,
            u.id AS uid, u.username, u.display_name
     FROM user_feedback f
     LEFT JOIN users u ON f.user_id = u.id
     ${whereClause}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    queryValues,
  );

  const parseContent = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return { open: String(raw) }; }
  };

  const items = rows.map((row) => {
    const parsed = parseContent(row.content) || {};
    return {
      id: Number(row.id),
      userId: row.uid === null ? null : Number(row.uid),
      username: row.username || null,
      displayName: row.display_name || null,
      content: parsed,
      createdAt: row.created_at,
      attachments: [],
    };
  });

  if (items.length > 0) {
    const ids = items.map((item) => item.id);
    const placeholders = ids.map(() => '?').join(',');
    const [attachmentRows] = await pool.query(
      `SELECT id, feedback_id, original_name, mime_type, size, created_at
       FROM feedback_attachments WHERE feedback_id IN (${placeholders}) ORDER BY id ASC`,
      ids,
    );
    const byFeedback = new Map(items.map((item) => [item.id, item]));
    for (const attachment of attachmentRows) {
      const item = byFeedback.get(Number(attachment.feedback_id));
      item?.attachments.push({
        id: Number(attachment.id),
        originalName: attachment.original_name,
        mimeType: attachment.mime_type,
        size: Number(attachment.size),
        createdAt: attachment.created_at,
        url: `/api/feedback-attachments/${Number(attachment.id)}`,
      });
    }
  }

  // 统计
  const [allRows] = await pool.execute(
    `SELECT f.content FROM user_feedback f${whereClause}`,
    queryValues,
  );
  let totalRating = 0;
  let ratingCount = 0;
  const ratingBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const featureCounts = {};
  let sceneClassroom = 0, sceneSelf = 0, sceneDemo = 0, sceneOther = 0;
  for (const r of allRows) {
    const p = parseContent(r.content);
    if (!p) continue;
    if (typeof p.rating === 'number' && p.rating > 0) {
      totalRating += p.rating;
      ratingCount++;
      const bucket = Math.round(p.rating);
      if (bucket >= 1 && bucket <= 5) ratingBuckets[bucket]++;
    }
    if (Array.isArray(p.features)) {
      for (const feat of p.features) featureCounts[feat] = (featureCounts[feat] || 0) + 1;
    }
    if (p.scene === 'classroom') sceneClassroom++;
    else if (p.scene === 'self') sceneSelf++;
    else if (p.scene === 'demo') sceneDemo++;
    else if (p.scene === 'other') sceneOther++;
  }
  const avgRating = ratingCount > 0 ? +(totalRating / ratingCount).toFixed(2) : null;

  return res.json({
    items,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    stats: {
      total,
      avgRating,
      ratingCount,
      ratingBuckets,
      featureCounts,
      sceneBreakdown: { classroom: sceneClassroom, self: sceneSelf, demo: sceneDemo, other: sceneOther },
    },
  });
});

app.patch('/api/admin/users/:id/status', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '无效的用户 ID' });
  }

  if (!['active', 'disabled'].includes(status)) {
    return res.status(400).json({ message: '无效的账号状态' });
  }

  if (id === req.user.id) {
    return res.status(400).json({ message: '不能禁用当前管理员账号' });
  }

  const target = await findUserById(id);
  if (!target) {
    return res.status(404).json({ message: '用户不存在' });
  }

  if (target.status === 'active' && status === 'disabled' && await wouldRemoveLastActiveAdmin(target)) {
    return res.status(400).json({ message: '不能禁用最后一个启用的管理员账号' });
  }

  await pool.execute(
    'UPDATE users SET status = :status WHERE id = :id',
    { id, status },
  );

  const updated = await findUserById(id);
  return res.json({ user: publicUser(updated) });
});

app.patch('/api/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const role = req.body.role;

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ message: '无效的用户 ID' });
  }

  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({ message: '无效的用户角色' });
  }

  if (id === req.user.id && role !== 'admin') {
    return res.status(400).json({ message: '不能降级当前管理员账号' });
  }

  const target = await findUserById(id);
  if (!target) {
    return res.status(404).json({ message: '用户不存在' });
  }

  if (target.role === 'admin' && role === 'user' && await wouldRemoveLastActiveAdmin(target)) {
    return res.status(400).json({ message: '不能降级最后一个启用的管理员账号' });
  }

  await pool.execute(
    'UPDATE users SET role = :role WHERE id = :id',
    { id, role },
  );

  const updated = await findUserById(id);
  return res.json({ user: publicUser(updated) });
});

app.get('/api/resource-library', requireAuth, async (_req, res) => {
  const tags = await loadResourceLibrary();
  res.json({ tags });
});

app.get('/api/resource-models/:modelId/files/:fileId', requireAuth, async (req, res, next) => {
  const modelId = Number(req.params.modelId);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(modelId) || modelId <= 0 || !Number.isInteger(fileId) || fileId <= 0) {
    return res.status(400).json({ message: '无效的模型文件 ID' });
  }

  const [rows] = await pool.execute(
    `SELECT resource_model_files.*
     FROM resource_model_files
     INNER JOIN resource_models ON resource_models.id = resource_model_files.model_id
     WHERE resource_model_files.id = :fileId
       AND resource_model_files.model_id = :modelId
       AND resource_models.source_kind = 'upload'
     LIMIT 1`,
    { modelId, fileId },
  );
  const file = rows[0];
  if (!file) return res.status(404).json({ message: '模型文件不存在' });

  const filePath = path.join(RESOURCE_MODEL_STORAGE_DIRECTORY, path.basename(file.storage_name));
  res.set({
    'Content-Type': file.mime_type || 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  });
  return res.sendFile(filePath, (error) => {
    if (error) next(error);
  });
});

app.post('/api/admin/resource-tags', requireAuth, requireAdmin, async (req, res) => {
  try {
    const name = normalizeResourceTagName(req.body.name);
    const iconKey = normalizeResourceIcon(req.body.iconKey);
    const [sortRows] = await pool.execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_sort_order FROM resource_tags',
    );
    const sortOrder = Number.isInteger(Number(req.body.sortOrder))
      ? Number(req.body.sortOrder)
      : Number(sortRows[0]?.next_sort_order || 10);
    const [result] = await pool.execute(
      'INSERT INTO resource_tags (name, icon_key, sort_order) VALUES (:name, :iconKey, :sortOrder)',
      { name, iconKey, sortOrder },
    );
    const tags = await loadResourceLibrary();
    return res.status(201).json({ tag: tags.find((tag) => tag.id === Number(result.insertId)) });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: '标签名称已存在' });
    }
    throw error;
  }
});

app.patch('/api/admin/resource-tags/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '无效的标签 ID' });
  if (!await findResourceTagById(id)) return res.status(404).json({ message: '标签不存在' });

  const updates = [];
  const values = { id };
  if (req.body.name !== undefined) {
    updates.push('name = :name');
    values.name = normalizeResourceTagName(req.body.name);
  }
  if (req.body.iconKey !== undefined) {
    updates.push('icon_key = :iconKey');
    values.iconKey = normalizeResourceIcon(req.body.iconKey);
  }
  if (req.body.sortOrder !== undefined) {
    const sortOrder = Number(req.body.sortOrder);
    if (!Number.isInteger(sortOrder)) return res.status(400).json({ message: '标签排序值必须是整数' });
    updates.push('sort_order = :sortOrder');
    values.sortOrder = sortOrder;
  }
  if (updates.length === 0) return res.status(400).json({ message: '请提供要更新的标签信息' });

  try {
    await pool.execute(`UPDATE resource_tags SET ${updates.join(', ')} WHERE id = :id`, values);
    const tags = await loadResourceLibrary();
    return res.json({ tag: tags.find((tag) => tag.id === id) });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: '标签名称已存在' });
    }
    throw error;
  }
});

app.delete('/api/admin/resource-tags/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '无效的标签 ID' });
  if (!await findResourceTagById(id)) return res.status(404).json({ message: '标签不存在' });

  const [countRows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM resource_models WHERE tag_id = :id',
    { id },
  );
  if (Number(countRows[0]?.count || 0) > 0) {
    return res.status(409).json({ message: '该标签中还有模型，请先移动或删除模型' });
  }

  await pool.execute('DELETE FROM resource_tags WHERE id = :id', { id });
  return res.json({ ok: true });
});

app.post('/api/admin/resource-models', requireAuth, requireAdmin, async (req, res) => {
  const upload = await parseResourceUpload(req);
  if (!Number.isInteger(upload.tagId) || upload.tagId <= 0) {
    throw httpError(400, '请选择有效的资源标签');
  }
  if (!await findResourceTagById(upload.tagId)) throw httpError(404, '资源标签不存在');

  const storedFiles = [];
  let connection;
  let committed = false;
  try {
    for (const item of upload.files) {
      const storageName = `${randomUUID()}${item.extension}`;
      const buffer = Buffer.from(await item.file.arrayBuffer());
      await writeFile(path.join(RESOURCE_MODEL_STORAGE_DIRECTORY, storageName), buffer, { flag: 'wx' });
      storedFiles.push({
        ...item,
        storageName,
        mimeType: item.file.type || 'application/octet-stream',
        isPrimary: item === upload.primaryFile,
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sortRows] = await connection.execute(
      'SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_sort_order FROM resource_models WHERE tag_id = :tagId',
      { tagId: upload.tagId },
    );
    const [result] = await connection.execute(
      `INSERT INTO resource_models
        (tag_id, name, model_type, source_kind, file_size, sort_order, created_by)
       VALUES (:tagId, :name, :modelType, 'upload', :fileSize, :sortOrder, :createdBy)`,
      {
        tagId: upload.tagId,
        name: upload.name,
        modelType: upload.primaryFile.extension.slice(1),
        fileSize: upload.totalSize,
        sortOrder: Number(sortRows[0]?.next_sort_order || 10),
        createdBy: req.user.id,
      },
    );
    const modelId = Number(result.insertId);

    for (const file of storedFiles) {
      await connection.execute(
        `INSERT INTO resource_model_files
          (model_id, original_name, storage_name, mime_type, file_size, is_primary)
         VALUES (:modelId, :originalName, :storageName, :mimeType, :fileSize, :isPrimary)`,
        {
          modelId,
          originalName: file.originalName,
          storageName: file.storageName,
          mimeType: file.mimeType,
          fileSize: file.file.size,
          isPrimary: file.isPrimary ? 1 : 0,
        },
      );
    }

    await connection.commit();
    committed = true;
    const model = await serializedResourceModel(modelId);
    return res.status(201).json({ model });
  } catch (error) {
    if (!committed) {
      if (connection) await connection.rollback();
      await removeStoredResourceFiles(storedFiles.map((file) => file.storageName));
    }
    throw error;
  } finally {
    connection?.release();
  }
});

app.patch('/api/admin/resource-models/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '无效的模型 ID' });
  if (!await findResourceModelById(id)) return res.status(404).json({ message: '模型不存在' });

  const updates = [];
  const values = { id };
  if (req.body.name !== undefined) {
    updates.push('name = :name');
    values.name = normalizeResourceName(req.body.name, '模型名称');
  }
  if (req.body.tagId !== undefined) {
    const tagId = Number(req.body.tagId);
    if (!Number.isInteger(tagId) || tagId <= 0 || !await findResourceTagById(tagId)) {
      return res.status(400).json({ message: '请选择有效的资源标签' });
    }
    updates.push('tag_id = :tagId');
    values.tagId = tagId;
  }
  if (req.body.sortOrder !== undefined) {
    const sortOrder = Number(req.body.sortOrder);
    if (!Number.isInteger(sortOrder)) return res.status(400).json({ message: '模型排序值必须是整数' });
    updates.push('sort_order = :sortOrder');
    values.sortOrder = sortOrder;
  }
  if (updates.length === 0) return res.status(400).json({ message: '请提供要更新的模型信息' });

  await pool.execute(`UPDATE resource_models SET ${updates.join(', ')} WHERE id = :id`, values);
  return res.json({ model: await serializedResourceModel(id) });
});

app.delete('/api/admin/resource-models/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: '无效的模型 ID' });
  if (!await findResourceModelById(id)) return res.status(404).json({ message: '模型不存在' });

  const [fileRows] = await pool.execute(
    'SELECT storage_name FROM resource_model_files WHERE model_id = :id',
    { id },
  );
  await pool.execute('DELETE FROM resource_models WHERE id = :id', { id });
  await removeStoredResourceFiles(fileRows.map((file) => file.storage_name));
  return res.json({ ok: true });
});

const AI3D_ENDPOINT = 'ai3d.tencentcloudapi.com';
const AI3D_API_VERSION = '2025-05-13';
const AI3D_MODEL_HOSTS = [
  '.cos.ap-guangzhou.tencentcos.cn',
  '.cos.ap-guangzhou.myqcloud.com',
];

function get3dGenerationClient() {
  const secretId = process.env.AI3D_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.AI3D_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY;

  if (!secretId || !secretKey) {
    throw new Error('缺少 3D 建模服务凭证，请配置 AI3D_SECRET_ID 和 AI3D_SECRET_KEY');
  }

  return new CommonClient(AI3D_ENDPOINT, AI3D_API_VERSION, {
    credential: { secretId, secretKey },
    region: process.env.AI3D_REGION || process.env.TENCENTCLOUD_REGION || 'ap-guangzhou',
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        reqMethod: 'POST',
        reqTimeout: 60,
        endpoint: AI3D_ENDPOINT,
      },
    },
  });
}

function generationError(error) {
  return {
    Error: {
      Code: error?.code || 'InternalError',
      Message: error?.message || '自研 3D 模型服务调用失败',
    },
    RequestId: error?.requestId || '',
  };
}

app.post('/api/3d/submit', requireAuth, async (req, res) => {
  try {
    const input = req.body || {};
    const params = { ResultFormat: input.ResultFormat || 'GLB' };

    const prompt = typeof input.Prompt === 'string' ? input.Prompt.trim() : String(input.Prompt || '').trim();
    const hasImageBase64 = typeof input.ImageBase64 === 'string' && input.ImageBase64.length > 0;
    const hasImageUrl = typeof input.ImageUrl === 'string' && input.ImageUrl.length > 0;

    if (prompt) {
      params.Prompt = prompt;
      req.activityLogDescription = build3dSubmissionDescription({ prompt });
    } else if (hasImageBase64 || hasImageUrl) {
      req.activityLogDescription = build3dSubmissionDescription({ image: true });
    }
    if (input.ImageBase64) params.ImageBase64 = input.ImageBase64;
    if (input.ImageUrl) params.ImageUrl = input.ImageUrl;
    if (typeof input.EnablePBR === 'boolean') params.EnablePBR = input.EnablePBR;
    if (typeof input.EnableGeometry === 'boolean') params.EnableGeometry = input.EnableGeometry;

    if (!params.Prompt && !params.ImageBase64 && !params.ImageUrl) {
      return res.status(400).json({ message: '请输入提示词或上传图片' });
    }

    const data = await get3dGenerationClient().request('SubmitHunyuanTo3DRapidJob', params);
    return res.json({ Response: data });
  } catch (error) {
    console.error('3D generation submit failed:', error);
    return res.status(500).json({ Response: generationError(error) });
  }
});

app.post('/api/3d/query', requireAuth, async (req, res) => {
  const jobId = String(req.body?.JobId || '').trim();
  if (!jobId) return res.status(400).json({ message: '缺少任务编号' });

  try {
    const data = await get3dGenerationClient().request('QueryHunyuanTo3DRapidJob', { JobId: jobId });
    return res.json({ Response: data });
  } catch (error) {
    console.error('3D generation query failed:', error);
    return res.status(500).json({ Response: generationError(error) });
  }
});

app.get('/api/3d/model', requireAuth, async (req, res) => {
  let modelUrl;
  try {
    modelUrl = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ message: '模型地址无效' });
  }

  const allowed = modelUrl.protocol === 'https:' && AI3D_MODEL_HOSTS.some((host) => modelUrl.hostname.endsWith(host));
  if (!allowed) return res.status(403).json({ message: '不允许访问该模型地址' });

  try {
    const upstream = await fetch(modelUrl, {
      cache: 'no-store',
      headers: req.headers.range ? { Range: String(req.headers.range) } : undefined,
    });
    if (!upstream.ok) return res.status(upstream.status).json({ message: `模型文件获取失败 (${upstream.status})` });
    if (!upstream.body) return res.status(502).json({ message: '模型存储服务未返回文件内容' });
    res.set({
      'Content-Type': upstream.headers.get('content-type') || 'model/gltf-binary',
      'Cache-Control': 'private, max-age=3600',
      ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {}),
      ...(upstream.headers.get('content-range') ? { 'Content-Range': upstream.headers.get('content-range') } : {}),
      ...(upstream.headers.get('accept-ranges') ? { 'Accept-Ranges': upstream.headers.get('accept-ranges') } : {}),
    });
    res.status(upstream.status);
    return Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    console.error('3D model proxy failed:', error);
    if (res.headersSent) return res.end();
    return res.status(502).json({ message: '无法连接模型存储服务' });
  }
});

const volcTtsService = createVolcTtsService();

attachVolcTtsWebSocketServer({
  server: httpServer,
  ttsService: volcTtsService,
  authenticate: authenticateWebSocketRequest,
  allowedOrigin: CLIENT_ORIGIN,
});

// --- 静态资源（放在所有 API 路由之后、error handler 之前） ---
const PUBLIC_DIR = path.resolve(path.join(SERVER_DIRECTORY, '..', 'public'));
const FRONTEND_DIST = path.resolve(path.join(SERVER_DIRECTORY, '..', 'dist'));
app.use('/mediapipe', express.static(path.join(PUBLIC_DIR, 'mediapipe'), { maxAge: '7d' }));
app.use('/brand', express.static(path.join(PUBLIC_DIR, 'brand'), { maxAge: '7d' }));
app.use('/draco', express.static(path.join(PUBLIC_DIR, 'draco'), { maxAge: '7d' }));
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), { maxAge: '7d' }));
app.use('/images', express.static(path.join(PUBLIC_DIR, 'images'), { maxAge: '7d' }));
app.use('/models', (_req, res, next) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  express.static(path.join(PUBLIC_DIR, 'models'), { maxAge: 0 })(_req, res, next);
});
app.use('/assets', express.static(path.join(FRONTEND_DIST, 'assets'), { maxAge: '1h' }));
// dist 根目录的静态文件（sw.js, manifest.webmanifest, favicon.ico 等）
app.use(express.static(FRONTEND_DIST, { maxAge: '1h', fallthrough: true }));
// SPA 兜底：非 /api/ 且非静态文件 → index.html
app.use((_req, res, next) => {
  if (_req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'), (err) => { if (err) next(err); });
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error);
  if (res.headersSent) return _next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: '图片体积过大，请压缩到 8MB 以内后重试' });
  }
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return res.status(error.status).json({ message: error.message || '请求失败' });
  }
  res.status(500).json({ message: '服务器错误' });
});

initializeDatabase()
  .then(() => {
    startLearningMemoryJobs(() => pool);
    httpServer.listen(PORT, () => {
      console.log(`API and TTS WebSocket listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start auth API:', explainStartupError(error));
    process.exit(1);
  });
