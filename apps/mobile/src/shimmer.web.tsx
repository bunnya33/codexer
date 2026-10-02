import './shimmer.web.css';

export function ShimmerLabel({ text }: { text: string }) {
  return <span className="codexer-shimmer" data-testid="active-step-shimmer">{text}</span>;
}
