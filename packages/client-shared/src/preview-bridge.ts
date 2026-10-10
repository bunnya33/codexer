/** Executed inside the opaque preview frame. It has no access to Relay credentials. */
export function previewRuntime(channel: string, saved: unknown) {
  type Control = { id: string; group: string; kind: string; label: string; value: unknown; initial: unknown; min?: number; max?: number; step?: number; options?: unknown[] };
  const controls = new Map<string, { descriptor: Control; object: Record<string, unknown>; property: string; render: () => void }>();
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  const send = (payload: Record<string, unknown>) => parent.postMessage(Object.assign({ channel }, payload), '*');
  const global = window as unknown as { openai: Record<string, unknown>; Tweak: unknown; lucide: { createIcons: () => void } };
  const initial = saved && typeof saved === 'object' ? saved : { modelContent: null, privateContent: null };
  global.openai = {
    widgetState: initial, theme: 'light', statePersistence: 'local',
    setWidgetState: (value: unknown) => {
      const next = typeof value === 'function' ? value(global.openai.widgetState) : value;
      if (!next || typeof next !== 'object' || Array.isArray(next)) return Promise.reject(new Error('交互状态格式无效'));
      const state = { modelContent: next.modelContent ?? null, privateContent: next.privateContent ?? null };
      if (new TextEncoder().encode(JSON.stringify(state)).length > 16384) return Promise.reject(new Error('交互状态超过 16 KB'));
      const id = String(++sequence);
      global.openai.widgetState = state;
      window.dispatchEvent(new CustomEvent('openai:set_globals', {detail:{globals:{widgetState:state}}}));
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('交互状态未保存')); }, 10000);
        pending.set(id, { resolve, reject, timeout }); send({ type: 'state', id, state });
      });
    },
    sendFollowUpMessage: (value: { prompt?: unknown; title?: unknown }) => {
      if (typeof value?.prompt === 'string' && value.prompt.trim()) send({ type: 'follow-up', prompt: value.prompt.slice(0, 20000), title: typeof value.title === 'string' ? value.title.slice(0, 160) : undefined });
      return Promise.resolve();
    },
    requestDisplayMode: () => Promise.resolve({ mode: 'inline' }),
  };
  const announce = () => send({ type: 'controls', controls: Array.from(controls.values()).map(value => value.descriptor) });
  type TweakOptions = { container: Element; onChange?: () => void; group?: string };
  type TweakInstance = { supported: boolean; group: string; ids: string[]; options: TweakOptions; add: (object: Record<string, unknown>, property: string, kind: string, options?: Record<string, unknown>) => void; addSlider: (object: Record<string, unknown>, property: string, options?: Record<string, unknown>) => void; addToggle: (object: Record<string, unknown>, property: string, options?: Record<string, unknown>) => void; addSelect: (object: Record<string, unknown>, property: string, options?: Record<string, unknown>) => void; addColorPicker: (object: Record<string, unknown>, property: string, options?: Record<string, unknown>) => void; dispose: () => void };
  // Plain functions avoid Babel class/spread helpers leaking out of this serialized runtime.
  const Tweak = function (this: TweakInstance, options: TweakOptions) {
    this.supported = true; this.ids = []; this.options = options;
    this.group = options.group || options.container.getAttribute('aria-label') || '预览参数';
  } as unknown as { new(options: TweakOptions): TweakInstance; prototype: TweakInstance };
  Tweak.prototype.add = function (object: Record<string, unknown>, property: string, kind: string, options: Record<string, unknown> = {}) {
      if (this.ids.length >= 12 || controls.size >= 72) return;
      const id = String(++sequence), value = object[property];
      const descriptor: Control = { id, group: this.group, kind, label: String(options.label || property).slice(0, 160), value, initial: value };
      if (kind === 'slider') {
        descriptor.min = Number(options.min ?? 0); descriptor.max = Number(options.max ?? 100); descriptor.step = Number(options.step ?? 1);
      }
      if (kind === 'select' && Array.isArray(options.options)) descriptor.options = options.options.slice(0, 12).map(value => typeof value === 'string' ? { label: value, value } : value);
      this.ids.push(id); controls.set(id, { descriptor, object, property, render: this.options.onChange || (() => {}) }); announce();
  };
  Tweak.prototype.addSlider = function (object, property, options) { this.add(object, property, 'slider', options); };
  Tweak.prototype.addToggle = function (object, property, options) { this.add(object, property, 'toggle', options); };
  Tweak.prototype.addSelect = function (object, property, options) { this.add(object, property, 'select', options); };
  Tweak.prototype.addColorPicker = function (object, property, options) { this.add(object, property, 'color', options); };
  Tweak.prototype.dispose = function () { this.ids.forEach(id => controls.delete(id)); announce(); };
  global.Tweak = Tweak;
  let annotating = false;
  let selectionTweak: TweakInstance | undefined;
  document.addEventListener('click', event => {
    if (!annotating || !(event.target instanceof HTMLElement)) return;
    event.preventDefault(); event.stopImmediatePropagation(); annotating = false;
    const target = event.target;
    const path: string[] = [];
    let node: HTMLElement | null = target;
    while (node && path.length < 6) {
      if (node.id && /^[a-z_][\w-]*$/i.test(node.id)) { path.unshift('#' + node.id); break; }
      const parentElement: HTMLElement | null = node.parentElement;
      const siblings: Element[] = parentElement ? Array.from(parentElement.children).filter(sibling => sibling.tagName === node!.tagName) : [];
      path.unshift(node.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''));
      node = parentElement;
    }
    const selector = path.join(' > '), style = getComputedStyle(target);
    send({ type: 'selection', selector, tag: target.localName, text: target.textContent?.trim().slice(0, 300) || '' });
    const state = { fontSize: parseFloat(style.fontSize) || 14, padding: parseFloat(style.paddingTop) || 0, radius: parseFloat(style.borderTopLeftRadius) || 0 };
    selectionTweak?.dispose();
    target.setAttribute('data-codexer-selected', 'true');
    selectionTweak = new Tweak({ container: target, group: '所选元素 ' + selector.slice(0, 120), onChange: () => { target.style.fontSize = state.fontSize + 'px'; target.style.padding = state.padding + 'px'; target.style.borderRadius = state.radius + 'px'; } });
    selectionTweak.addSlider(state, 'fontSize', { label: '字号', min: 10, max: 64, unit: 'px' });
    selectionTweak.addSlider(state, 'padding', { label: '内边距', min: 0, max: 64, unit: 'px' });
    selectionTweak.addSlider(state, 'radius', { label: '圆角', min: 0, max: 40, unit: 'px' });
  }, true);
  // A local icon fallback keeps previews usable without granting additional network access.
  global.lucide = { createIcons: () => document.querySelectorAll('[data-lucide]').forEach(node => { if (!node.textContent) node.textContent = '·'; }) };
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return;
    const message = event.data;
    if (message.type === 'initialize') {
      announce(); measure();
    } else if (message.type === 'annotate') {
      annotating = message.enabled === true;
    } else if (message.type === 'state-result') {
      const value = pending.get(message.id); if (!value) return;
      clearTimeout(value.timeout); pending.delete(message.id);
      if (message.ok) value.resolve(); else value.reject(new Error('交互状态未保存'));
    } else if (message.type === 'tweak') {
      const entry = controls.get(message.id); if (!entry) return;
      let value = message.value;
      if (entry.descriptor.kind === 'slider') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return;
        value = Math.max(entry.descriptor.min!, Math.min(entry.descriptor.max!, value));
      } else if (entry.descriptor.kind === 'toggle' && typeof value !== 'boolean') return;
      else if (entry.descriptor.kind === 'color' && (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value))) return;
      else if (entry.descriptor.kind === 'select' && !entry.descriptor.options?.some(option => (option as { value: unknown }).value === value)) return;
      entry.object[entry.property] = value; entry.descriptor.value = value; entry.render(); announce(); measure();
    }
  });
  let scheduled = false;
  function measure() {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      send({ type: 'height', height: Math.min(2400, Math.max(120, Math.ceil(height))) });
    });
  }
  window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav[role="tablist"]').forEach(list => list.addEventListener('click', event => {
      const tab = (event.target as Element).closest<HTMLButtonElement>('[role="tab"]'); if (!tab || tab.disabled) return;
      list.querySelectorAll('[role="tab"]').forEach(node => {
        const selected = node === tab; node.setAttribute('aria-selected', String(selected)); node.classList.toggle('active', selected);
        const panel = document.getElementById(node.getAttribute('aria-controls') || ''); if (panel) panel.hidden = !selected;
      }); measure();
    }));
    document.querySelectorAll('.viz-carousel').forEach(root => {
      const variants = Array.from(root.children).filter(node => node.hasAttribute('data-variant')) as HTMLElement[];
      if (variants.length < 2) return;
      const picker = document.createElement('select'); picker.className = 'form-select'; picker.setAttribute('aria-label', '预览方案');
      variants.forEach((variant, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = variant.dataset.variant!; picker.append(option); });
      picker.addEventListener('change', () => { variants.forEach((variant, index) => { variant.hidden = index !== Number(picker.value); }); measure(); }); root.append(picker);
    });
    global.lucide.createIcons();
    new ResizeObserver(measure).observe(document.body);
    send({ type: 'ready' }); measure();
  });
}
