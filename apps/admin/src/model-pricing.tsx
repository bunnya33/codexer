import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Calculator, Download, Pencil, Plus, RefreshCw, Save, Search, Trash2, Upload } from 'lucide-react';
import {
  MAX_MODEL_RATE, MAX_MODEL_RATES, MAX_PRICING_FILE_BYTES, modelPricingSchema, modelRateSchema,
} from '../../../packages/shared/src/model-pricing';
import type { ModelPricing, ModelRate, VersionedModelPricing } from '../../../packages/shared/src/model-pricing';
import * as api from './api';
import { Modal } from './modal';

type Dialog = { kind: 'edit'; rate?: ModelRate }
  | { kind: 'estimate'; rate: ModelRate }
  | { kind: 'remove'; id: string }
  | { kind: 'import'; catalog: ModelPricing }
  | { kind: 'reload' };

const rateUnit = '美元 / 100 万 Token';
const rateFields = [
  { key: 'input', name: '未缓存输入', example: '10,000' },
  { key: 'cachedInput', name: '缓存命中输入', example: '40,000' },
  { key: 'output', name: '输出', example: '5,000' },
] as const;
const estimateCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

function formatRate(rate: number) {
  const amount = String(rate);
  if (amount.includes('e')) return `$${amount}`;
  const [integer, fraction = ''] = amount.split('.');
  return `$${Number(integer).toLocaleString('en-US')}.${fraction.padEnd(2, '0')}`;
}

function tokenCount(value: string): number | null {
  const count = value.trim();
  if (!count) return 0;
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(count)) return null;
  const parsed = Number(count.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatEstimate(cost: number) {
  return cost > 0 && cost < 0.0001 ? '<$0.0001' : estimateCurrency.format(cost);
}

function RateEstimate({ rate, close }: { rate: ModelRate; close: () => void }) {
  const [counts, setCounts] = useState<Record<typeof rateFields[number]['key'], string>>({
    input: rateFields[0].example,
    cachedInput: rateFields[1].example,
    output: rateFields[2].example,
  });
  const items = rateFields.map(({ key, name }) => {
    const count = tokenCount(counts[key]);
    const price = rate[key];
    const cost = count === 0 ? 0 : count === null || price === null ? null : count * price / 1_000_000;
    return { key, name, count, price, cost };
  });
  const invalid = items.some(item => item.count === null);
  const unavailable = items.some(item => item.price === null && (item.count ?? 0) > 0);
  const total = items.reduce((sum, item) => sum + (item.cost ?? 0), 0);
  return <Modal title="Token 费用试算" close={close}>
    <div className="pricing-estimate">
      <div className="pricing-estimate-model">
        <code>{rate.id}</code>
        <p className="muted">标准速度 · 短上下文</p>
      </div>
      <div className="pricing-estimate-columns">
        <span>用量（Token）</span><span>预估费用</span>
      </div>
      {items.map(({ key, name, count, price, cost }) => <div className="pricing-estimate-row" key={key}>
        <label>
          <span>{name}</span>
          <input inputMode="numeric" value={counts[key]} placeholder="0" aria-invalid={count === null}
            onChange={event => setCounts({ ...counts, [key]: event.target.value })}/>
        </label>
        <div className="pricing-estimate-subtotal">
          <strong>{cost === null ? (price === null ? '未设费率' : '待计算') : formatEstimate(cost)}</strong>
          {price !== null && <small className="muted">{formatRate(price)} / 100 万 Token</small>}
        </div>
      </div>)}
      <div className="pricing-estimate-total" role="status">
        <span>{unavailable && !invalid ? '已计价小计' : '预估合计'}</span>
        <strong>{invalid ? '待计算' : formatEstimate(total)}</strong>
      </div>
      {invalid ? <p className="error" role="alert">Token 数须为非负整数，可用逗号分隔千位。</p>
        : unavailable && <p className="muted">当前模型缺少缓存命中费率，小计仅含可计价用量。</p>}
      <p className="muted pricing-scope-note">按表中费率估算。长上下文和缓存写入适用其他费率。</p>
    </div>
  </Modal>;
}

function RateEditor({ rate, models, close, apply }: {
  rate?: ModelRate;
  models: ModelRate[];
  close: () => void;
  apply: (rate: ModelRate) => void;
}) {
  const [error, setError] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const cached = fields.get('cachedInput');
    const parsed = modelRateSchema.safeParse({
      id: String(fields.get('id')).trim(),
      input: Number(fields.get('input')),
      cachedInput: cached === '' ? null : Number(cached),
      output: Number(fields.get('output')),
    });
    if (!parsed.success) {
      setError('请输入有效的模型 ID 和非负费率。');
    } else if (parsed.data.id !== rate?.id && models.some(model => model.id === parsed.data.id)) {
      setError('该模型 ID 已存在。');
    } else {
      apply(parsed.data);
    }
  };
  return <Modal title={rate ? '编辑模型费率' : '添加模型费率'} close={close}>
    <form className="pricing-editor" onSubmit={submit}>
      <p id="pricing-editor-unit" className="muted pricing-scope-note">标准速度 · 短上下文 · {rateUnit}</p>
      <label>模型 ID<input name="id" defaultValue={rate?.id} required maxLength={128}/></label>
      {rateFields.map(({ key, name }) => <div className="pricing-editor-field" key={key}>
        <label htmlFor={`pricing-editor-${key}`}>{name}费率</label>
        <span className="pricing-currency-input">
          <span aria-hidden="true">$</span>
          <input id={`pricing-editor-${key}`} name={key} type="number" step="any" min="0" max={MAX_MODEL_RATE} required={key !== 'cachedInput'}
            defaultValue={rate?.[key] ?? ''} aria-describedby={key === 'cachedInput' ? 'pricing-editor-unit pricing-cached-hint' : 'pricing-editor-unit'}/>
        </span>
        {key === 'cachedInput' && <small id="pricing-cached-hint" className="muted">留空表示未设费率。填写 0 表示免费。</small>}
      </div>)}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions"><button type="button" onClick={close}>取消</button><button className="primary">应用到草稿</button></div>
    </form>
  </Modal>;
}

export function ModelPricingPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [saved, setSaved] = useState<VersionedModelPricing>();
  const [draft, setDraft] = useState<ModelPricing>();
  const [busy, setBusy] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog>();
  const fileInput = useRef<HTMLInputElement>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const dirty = !!draft && draft !== saved?.catalog;
  const close = () => setDialog(undefined);

  const load = async (signal?: AbortSignal) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api.modelPricing(signal);
      if (signal?.aborted) return;
      setSaved(value);
      setDraft(value.catalog);
      setConflict(false);
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof api.ApiError && e.status === 401) unauthorized.current();
      else setError('无法读取模型费率，请刷新重试。');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  const save = async () => {
    if (!saved || !draft) return;
    const parsed = modelPricingSchema.safeParse(draft);
    if (!parsed.success) {
      setError('请填写有效的费率日期，来源留空或填写 HTTPS 链接。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await api.saveModelPricing({ revision: saved.revision, catalog: parsed.data });
      setSaved(value);
      setDraft(value.catalog);
      setNotice('费率已保存。');
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 401) unauthorized.current();
      else if (e instanceof api.ApiError && e.status === 409) {
        setConflict(true);
        setError('服务器费率已变更。可先导出当前草稿，再刷新获取最新版本。');
      } else {
        setError('费率保存失败，草稿已保留。');
      }
    } finally {
      setBusy(false);
    }
  };

  const importFile = async (file: File) => {
    setError('');
    setNotice('');
    if (file.size > MAX_PRICING_FILE_BYTES) {
      setError('JSON 文件不能超过 128 KB。');
      return;
    }
    setBusy(true);
    try {
      const parsed = modelPricingSchema.safeParse(JSON.parse(await file.text()));
      if (parsed.success) setDialog({ kind: 'import', catalog: parsed.data });
      else {
        const issue = parsed.error.issues[0];
        setError(issue?.code === 'custom' ? issue.message : `费率结构无效（${issue?.path.join('.') || '根对象'}）。请参照导出的 JSON 文件。`);
      }
    } catch {
      setError('无法读取 JSON 文件。');
    } finally {
      setBusy(false);
    }
  };

  const exportFile = () => {
    const parsed = modelPricingSchema.safeParse(draft);
    if (!parsed.success) {
      setError('请先修正费率日期或来源，再导出。');
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(parsed.data, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `model-pricing-${parsed.data.asOf}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const models = draft?.models ?? [];
  const rows = models.filter(model => model.id.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="model-pricing" aria-label="模型费率">
    <div className="page-head">
      <div className="pricing-basis">
        <strong>{rateUnit}</strong>
        <p className="muted">标准速度 · 短上下文</p>
      </div>
      <div className="actions">
        <button disabled={busy} onClick={() => dirty ? setDialog({ kind: 'reload' }) : void load()}><RefreshCw size={16}/>刷新</button>
        <button disabled={!draft || busy} onClick={() => fileInput.current?.click()}><Upload size={16}/>导入 JSON</button>
        <input ref={fileInput} type="file" hidden accept=".json,application/json" aria-label="导入费率文件" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void importFile(file);
        }}/>
        <button disabled={!draft || busy} onClick={exportFile}><Download size={16}/>导出 JSON</button>
        <button className="primary" disabled={!dirty || busy || conflict} onClick={() => void save()}><Save size={16}/>保存费率</button>
      </div>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {(notice || dirty) && <p className="muted" role="status">{dirty ? '有未保存的费率变更' : notice}</p>}
    {draft ? <>
      <div className="pricing-metadata">
        <label>费率日期<input type="date" required value={draft.asOf} disabled={busy} onChange={e => setDraft({ ...draft, asOf: e.target.value })}/></label>
        <label>来源（可选）<input type="url" value={draft.source ?? ''} disabled={busy} maxLength={512} onChange={e => setDraft({ ...draft, source: e.target.value || null })}/></label>
      </div>
      <div className="table-toolbar">
        <span>{models.length} 个模型</span>
        <div className="actions">
          <label className="search"><Search size={16}/><input aria-label="搜索模型 ID" placeholder="搜索模型 ID" value={search} onChange={e => setSearch(e.target.value)}/></label>
          <button disabled={busy || models.length >= MAX_MODEL_RATES} onClick={() => setDialog({ kind: 'edit' })}><Plus size={16}/>添加模型</button>
        </div>
      </div>
      <div className="table-scroll">
        <table role="table" aria-label="模型费率，美元 / 100 万 Token">
          <thead role="rowgroup"><tr role="row">
            <th role="columnheader" scope="col">模型 ID</th>
            {rateFields.map(({ key, name }) => <th role="columnheader" scope="col" key={key}>
              {name}费率<small>{rateUnit}</small>
            </th>)}
            <th role="columnheader" scope="col" className="align-right">操作</th>
          </tr></thead>
          <tbody role="rowgroup">{rows.map(rate => <tr role="row" key={rate.id}>
            <td role="cell" className="pricing-model-id"><code>{rate.id}</code></td>
            {rateFields.map(({ key, name }) => <td role="cell" key={key} className="pricing-amount">
              <span className="pricing-mobile-label" aria-hidden="true">{name}</span>
              {rate[key] === null ? <span className="muted">未设费率</span> : <strong>{formatRate(rate[key])}</strong>}
            </td>)}
            <td role="cell" className="pricing-row-tools"><div className="row-actions">
              <button className="icon-button pricing-estimate-button" title="费用试算" aria-label={`试算 ${rate.id}`} disabled={busy} onClick={() => setDialog({ kind: 'estimate', rate })}>
                <Calculator size={16}/><span>试算</span>
              </button>
              <button className="icon-button" title="编辑" aria-label={`编辑 ${rate.id}`} disabled={busy} onClick={() => setDialog({ kind: 'edit', rate })}><Pencil size={16}/></button>
              <button className="icon-button danger" title="移除" aria-label={`移除 ${rate.id}`} disabled={busy} onClick={() => setDialog({ kind: 'remove', id: rate.id })}><Trash2 size={16}/></button>
            </div></td>
          </tr>)}</tbody>
        </table>
        {!rows.length && <p className="empty">{search.trim() ? '没有匹配的模型' : '暂无模型费率'}</p>}
      </div>
    </> : busy && <p role="status" className="muted">正在读取费率…</p>}
    {draft && dialog?.kind === 'edit' && <RateEditor rate={dialog.rate} models={models} close={close} apply={rate => {
      setDraft({ ...draft, models: dialog.rate ? models.map(row => row.id === dialog.rate?.id ? rate : row) : [rate, ...models] });
      setSearch('');
      close();
    }}/>}
    {dialog?.kind === 'estimate' && <RateEstimate rate={dialog.rate} close={close}/>}
    {draft && dialog?.kind === 'remove' && <Modal title="移除模型费率" close={close}>
      <p>从草稿移除 <code>{dialog.id}</code>？</p>
      <div className="actions"><button onClick={close}>取消</button><button className="danger" onClick={() => {
        setDraft({ ...draft, models: models.filter(row => row.id !== dialog.id) });
        close();
      }}>移除</button></div>
    </Modal>}
    {dialog?.kind === 'import' && <Modal title="确认导入费率" close={close}>
      <p>将用文件中的 {dialog.catalog.models.length} 个模型替换当前草稿。费率日期 {dialog.catalog.asOf}。</p>
      <div className="actions"><button onClick={close}>取消</button><button className="primary" onClick={() => {
        setDraft(dialog.catalog);
        setSearch('');
        close();
      }}>替换草稿</button></div>
    </Modal>}
    {dialog?.kind === 'reload' && <Modal title="刷新费率" close={close}>
      <p>刷新将丢弃当前草稿。</p>
      <div className="actions"><button onClick={close}>取消</button><button className="primary" onClick={() => { close(); void load(); }}>丢弃并刷新</button></div>
    </Modal>}
  </section>;
}
