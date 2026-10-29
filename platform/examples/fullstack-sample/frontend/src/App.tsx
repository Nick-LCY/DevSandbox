import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createRecord,
  exchangeCode,
  fetchMe,
  fetchRecords,
  fileDownloadUrl,
  logout,
  startLogin,
} from './api';
import type { RecordItem, UserInfo } from './types';

/** 回调路径：Logto 登录成功后浏览器会落到这里。 */
const CALLBACK_PATH = '/auth/callback';

/** 提交加载态的最短显示时长（毫秒）。请求很快返回时也不让加载态一闪而过。 */
const MIN_LOADING_MS = 300;

/** 等一小会儿（毫秒）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function CallbackView() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    if (oauthError) {
      setError(`Logto 返回错误：${oauthError}`);
      return;
    }
    if (!code || !state) {
      setError('回调地址缺少 code 或 state');
      return;
    }

    void exchangeCode(code, state)
      .then(() => {
        window.history.replaceState({}, '', '/');
        window.location.reload();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  return (
    <main className="page">
      <h1 data-testid="page-auth-callback-title">正在完成登录…</h1>
      <p data-testid="page-auth-callback-status">正在与 Logto 交换令牌并校验 id_token</p>
      {error ? (
        <p className="error" data-testid="page-auth-callback-error">
          {error}
        </p>
      ) : null}
    </main>
  );
}

function HomeView() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 过滤框里的原始关键字（用户正在输入的）。 */
  const [filterInput, setFilterInput] = useState('');
  /** 已经应用的关键字（点「过滤」之后才生效）。 */
  const [appliedFilter, setAppliedFilter] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 加载元素挂到页面上的时刻，用来保证它至少显示 MIN_LOADING_MS 毫秒。 */
  const loadingShownAtRef = useRef<number | null>(null);

  const refreshRecords = useCallback(async () => {
    const result = await fetchRecords();
    setRecords(result.records);
  }, []);

  // 提交进行中：记下加载元素真正出现在页面上的时刻。
  useEffect(() => {
    if (submitting) {
      loadingShownAtRef.current = Date.now();
    }
  }, [submitting]);

  /**
   * 列表展示用的记录：按已应用的关键字过滤标题与内容，不区分大小写。
   * 只影响展示，接口 GET /api/records 仍然返回全量。
   */
  const visibleRecords = useMemo(() => {
    const keyword = appliedFilter.trim().toLowerCase();
    if (keyword === '') {
      return records;
    }
    return records.filter((record) => {
      const titleText = (record.title ?? '').toLowerCase();
      const contentText = (record.content ?? '').toLowerCase();
      return titleText.includes(keyword) || contentText.includes(keyword);
    });
  }, [records, appliedFilter]);

  useEffect(() => {
    void fetchMe()
      .then((result) => {
        setUser(result.user);
        if (result.user) {
          return refreshRecords();
        }
        return undefined;
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        setReady(true);
      });
  }, [refreshRecords]);

  const handleLogin = async () => {
    setError(null);
    try {
      const result = await startLogin();
      window.location.href = result.authorizeUrl;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setRecords([]);
    setStatus('已登出');
  };

  /** 点「过滤」：把输入框里的关键字应用到列表上。 */
  const handleApplyFilter = () => {
    setAppliedFilter(filterInput);
  };

  /** 点「清除」：清空关键字并恢复全量列表（等价于「置空后再点过滤」）。 */
  const handleClearFilter = () => {
    setFilterInput('');
    setAppliedFilter('');
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);
    setError(null);
    try {
      const form = new FormData();
      form.append('title', title);
      form.append('content', content);
      if (file) {
        form.append('file', file);
      }
      const result = await createRecord(form);
      setTitle('');
      setContent('');
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      setStatus(`已保存记录：${result.record.title}`);
      await refreshRecords();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // 加载态至少显示 MIN_LOADING_MS 毫秒：请求很快返回时也不立刻消失。
      const shownAt = loadingShownAtRef.current ?? Date.now();
      const elapsed = Date.now() - shownAt;
      if (elapsed < MIN_LOADING_MS) {
        await sleep(MIN_LOADING_MS - elapsed);
      }
      setSubmitting(false);
    }
  };

  return (
    <main className="page">
      <header className="header">
        <div>
          <h1 data-testid="page-home-title">全栈示例 · 记录看板</h1>
          <p data-testid="page-home-subtitle">FastAPI + Postgres + MinIO + Logto</p>
        </div>
        {user ? (
          <div className="session">
            <span data-testid="page-home-user-name">{user.name}</span>
            {user.email ? <span data-testid="page-home-user-email">{user.email}</span> : null}
            <button type="button" data-testid="page-home-logout-button" onClick={handleLogout}>
              登出
            </button>
          </div>
        ) : (
          <button type="button" data-testid="page-home-login-button" onClick={handleLogin}>
            用 Logto 登录
          </button>
        )}
      </header>

      {!ready ? <p data-testid="page-home-loading">正在加载…</p> : null}

      {error ? (
        <p className="error" data-testid="page-home-error-message">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="status" data-testid="page-home-record-submit-status">
          {status}
        </p>
      ) : null}

      {user ? (
        <section className="panel">
          <h2>新建记录</h2>
          <form data-testid="page-home-record-form" onSubmit={handleSubmit}>
            <label>
              标题
              <input
                data-testid="page-home-record-title-input"
                name="title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
            </label>
            <label>
              内容
              <textarea
                data-testid="page-home-record-content-input"
                name="content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
              />
            </label>
            <label>
              附件（可选，存到 MinIO）
              <input
                data-testid="page-home-record-file-input"
                name="file"
                type="file"
                ref={fileInputRef}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {submitting ? (
              <p className="loading" data-testid="page-home-record-upload-loading" role="status">
                上传中…
              </p>
            ) : null}
            <button type="submit" data-testid="page-home-record-submit-button" disabled={submitting}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </form>
        </section>
      ) : null}

      <section className="panel">
        <h2>记录列表</h2>
        <div className="filter-bar" data-testid="page-home-record-filter-bar">
          <input
            data-testid="page-home-record-filter-input"
            type="text"
            placeholder="按标题或内容过滤"
            value={filterInput}
            onChange={(event) => setFilterInput(event.target.value)}
          />
          <button type="button" data-testid="page-home-record-filter-button" onClick={handleApplyFilter}>
            过滤
          </button>
          <button type="button" data-testid="page-home-record-filter-clear-button" onClick={handleClearFilter}>
            清除
          </button>
        </div>
        {records.length === 0 ? (
          <p data-testid="page-home-record-list-empty">还没有记录</p>
        ) : null}
        {records.length > 0 && visibleRecords.length === 0 ? (
          <p data-testid="page-home-record-list-no-match">
            没有匹配「{appliedFilter.trim()}」的记录
          </p>
        ) : null}
        <ul data-testid="page-home-record-list">
          {visibleRecords.map((record) => (
              <li key={record.id} data-testid="page-home-record-list-item">
                <div className="record-title" data-testid="page-home-record-list-item-title">
                  {record.title}
                </div>
                <div className="record-content" data-testid="page-home-record-list-item-content">
                  {record.content}
                </div>
                <div className="record-owner" data-testid="page-home-record-list-item-owner">
                  {record.ownerName}
                </div>
                {record.objectName ? (
                  <a
                    data-testid="page-home-record-list-item-file-link"
                    href={fileDownloadUrl(record.id)}
                    download={record.objectName}
                  >
                    下载 {record.objectName}（{record.objectSize} 字节）
                  </a>
                ) : null}
              </li>
            ))}
        </ul>
      </section>
    </main>
  );
}

export default function App() {
  const [path] = useState(window.location.pathname);
  if (path === CALLBACK_PATH) {
    return <CallbackView />;
  }
  return <HomeView />;
}
