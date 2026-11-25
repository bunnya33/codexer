import { useRef, useState } from "react";
import { createPublishingKey } from "./api";
import { Modal } from "./modal";
import { defaultPublishingScopes, publishingScopeNames } from "../../../packages/shared/src/publishing";
import type { PublishingKey } from "../../../packages/shared/src/publishing";

export function PublishingKeyDialog({ close }: { close: () => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState(defaultPublishingScopes);
  const [days, setDays] = useState(90);
  const [key, setKey] = useState<PublishingKey | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false),
    codeField = useRef<HTMLTextAreaElement>(null);
  const copy = async () => {
    if (!key) return;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(key.code);
        copied = true;
      }
    } catch {
      /* HTTP and denied clipboard access use the selection fallback. */
    }
    if (!copied) {
      codeField.current?.focus();
      codeField.current?.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        /* Leave selected for manual copy. */
      }
    }
    setNotice(copied ? "已复制授权码。" : "已选中授权码，请按 Ctrl+C 或长按复制。");
  };
  return (
    <Modal
      title={key ? "保存发布授权码" : "生成发布授权码"}
      close={() => {
        if (!pending.current) close();
      }}
    >
      {key ? (
        <>
          <p>
            授权码仅在此处显示一次。请复制并在本地发布工具中使用；关闭后无法再次查看，丢失后需撤销并重新生成。
          </p>
          <label>
            发布授权码
            <textarea
              ref={codeField}
              aria-label="发布授权码"
              readOnly
              value={key.code}
              rows={3}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="muted">
            {key.name} · 有效至 {new Date(key.expiresAt).toLocaleString("zh-CN")}
          </p>
          <div className="actions">
            <button onClick={() => void copy()}>复制授权码</button>
            <button className="primary" onClick={close}>
              已保存，关闭
            </button>
          </div>
          {notice && <p role="status">{notice}</p>}
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending.current) return;
            if (!name.trim() || scopes.length === 0) {
              setError("请输入名称并至少选择一项权限。");
              return;
            }
            pending.current = true;
            setBusy(true);
            setError("");
            try {
              setKey(await createPublishingKey(name.trim(), scopes, days));
            } catch (e) {
              setError(e instanceof Error ? e.message : "生成失败");
            } finally {
              pending.current = false;
              setBusy(false);
            }
          }}
        >
          <label>
            授权名称
            <input
              required
              maxLength={100}
              value={name}
              placeholder="例如：家中电脑发布工具"
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset disabled={busy}>
            <legend>授权权限</legend>
            {Object.entries(publishingScopeNames).map(([scope, title]) => (
              <label key={scope} className="publishing-scope">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                    )
                  }
                />
                {title}
              </label>
            ))}
          </fieldset>
          <label>
            有效期
            <select disabled={busy} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 天</option>
              <option value={30}>30 天</option>
              <option value={90}>90 天</option>
            </select>
          </label>
          <p className="muted">
            可用于 HTTP 或 HTTPS 服务器地址。授权码在有效期内可重复使用，管理员可随时撤销。
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy || !scopes.length}>
            {busy ? "正在生成…" : "生成授权码"}
          </button>
        </form>
      )}
    </Modal>
  );
}
