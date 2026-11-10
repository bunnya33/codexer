import { useEffect, useState } from "react";
import { KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import * as api from "./api";
import { Modal } from "./modal";

import { publishingScopeNames } from "../../../packages/shared/src/publishing";
import type {
  PublishRequest,
  PublishingGrant as Grant,
  PublishingInfo as Publishing,
} from "../../../packages/shared/src/publishing";
const date = (v: number) => new Date(v).toLocaleString("zh-CN");

export function PublishingApproval({ code, close }: { code: string; close: () => void }) {
  const [request, setRequest] = useState<PublishRequest | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  useEffect(() => {
    let active = true;
    api
      .publishingRequest(code)
      .then((v) => {
        if (active) setRequest(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [code]);
  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.approvePublishing(code, approve);
      setResult(approve ? "已授权。请返回本机发布工具，它会自动接收授权。" : "已拒绝该请求。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="授权发布工具" close={close}>
      {result ? (
        <>
          <p role="status">{result}</p>
          <button className="primary" onClick={close}>
            完成
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            仅为你正在操作的电脑授权。核对电脑名称和工具上显示的验证码；不要批准别人发来的请求。
          </p>
          {request && (
            <>
              <div className="publishing-request">
                <KeyRound size={24} />
                <strong>{request.name}</strong>
                <code>{request.code}</code>
              </div>
              <ul>
                {request.scopes.map((scope) => (
                  <li key={scope}>{publishingScopeNames[scope] || scope}</li>
                ))}
              </ul>
              <p className="muted">
                授权最长 90 天，连续 30
                天未续期失效，可随时撤销。该凭据不能管理账号或读取会话内容。发布客户端不会自动安装到设备。
              </p>
              <p className="footnote">本次请求有效至 {date(request.expiresAt)}。</p>
              {request.status !== "pending" && (
                <p role="status">此请求已处理，请在工具中重新申请。</p>
              )}
              <div className="actions">
                <button
                  disabled={busy || request.status !== "pending"}
                  onClick={() => void decide(false)}
                >
                  拒绝
                </button>
                <button
                  className="primary"
                  disabled={busy || request.status !== "pending" || request.expiresAt <= Date.now()}
                  onClick={() => void decide(true)}
                >
                  <ShieldCheck size={17} />
                  {busy ? "正在处理…" : "允许发布"}
                </button>
              </div>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

export function PublishingPanel() {
  const [data, setData] = useState<Publishing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revoke, setRevoke] = useState<Grant | null>(null),
    [code, setCode] = useState(""),
    [approval, setApproval] = useState("");
  const refresh = async () => {
    setError("");
    try {
      setData(await api.publishingInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <section className="card publishing-panel">
        <div className="page-head">
          <div>
            <h2>
              <KeyRound size={20} />
              发布授权
            </h2>
            <p className="muted">管理本机工具的独立授权。撤销后，访问令牌和刷新凭据立即失效。</p>
          </div>
          <button disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            setApproval(code.toUpperCase().trim());
          }}
        >
          <label>
            工具验证码
            <input
              placeholder="ABCD-1234"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={9}
              pattern="[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}"
              required
            />
          </label>
          <button>查看授权请求</button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>电脑 / 管理员</th>
                <th>权限</th>
                <th>有效期 / 最近续期</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.grants.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                    <small>{g.username}</small>
                  </td>
                  <td>
                    {g.scopes.split(" ").map((s) => (
                      <small key={s}>{publishingScopeNames[s] || s}</small>
                    ))}
                  </td>
                  <td>
                    <small>{date(g.expires_at)}</small>
                    <small>{date(g.last_used_at)}</small>
                  </td>
                  <td>
                    {g.revoked_at
                      ? "已撤销"
                      : g.expires_at <= Date.now() || g.last_used_at + 30 * 86400000 <= Date.now()
                        ? "已过期"
                        : "有效"}
                  </td>
                  <td>
                    <button
                      className="danger"
                      disabled={busy || !!g.revoked_at}
                      onClick={() => setRevoke(g)}
                    >
                      撤销
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.grants.length && (
            <p className="empty">暂无发布授权。运行本机发布工具的 login 命令申请。</p>
          )}
        </div>
      </section>
      <section className="card publishing-panel">
        <h2>发布操作记录</h2>
        <p className="muted">
          记录授权、撤销、安装包发布和服务器更新请求；保留最近 10,000 条，显示最近 200
          条。服务器最终安装状态仍以“服务器更新”为准。
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作 / 文件</th>
                <th>授权 ID</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {data?.audit.map((a) => (
                <tr key={a.id}>
                  <td>{date(a.at)}</td>
                  <td>
                    <small>{a.action}</small>
                    <small>{a.target}</small>
                  </td>
                  <td>
                    <small>{a.grant_id || "管理员操作"}</small>
                  </td>
                  <td className={a.outcome === "succeeded" ? "positive" : "error"}>
                    {a.outcome === "succeeded" ? "成功" : "拒绝"}
                    {a.code && <small>{a.code}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {revoke && (
        <Modal
          title={`撤销 ${revoke.name} 的授权？`}
          close={() => {
            if (!busy) setRevoke(null);
          }}
        >
          <p>该电脑需要重新在网页授权才能继续发布。已经完成的更新和客户端安装包保留。</p>
          <div className="actions">
            <button disabled={busy} onClick={() => setRevoke(null)}>
              取消
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .revokePublishing(revoke.id)
                  .then(async () => {
                    setRevoke(null);
                    await refresh();
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              确认撤销
            </button>
          </div>
        </Modal>
      )}
      {approval && (
        <PublishingApproval
          code={approval}
          close={() => {
            setApproval("");
            void refresh();
          }}
        />
      )}
    </>
  );
}
