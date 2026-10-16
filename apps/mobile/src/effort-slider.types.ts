export type EffortSliderProps = {
  labels: string[]; value: number; disabled: boolean;
  onChange: (index: number) => void; onCommit: (index: number) => void;
};
