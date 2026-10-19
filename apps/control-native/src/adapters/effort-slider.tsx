import React from 'react';
import {Slider} from './slider';
import type {EffortSliderProps} from '../../../mobile/src/effort-slider.types';
export function EffortSlider({labels,value,disabled,onChange,onCommit}:EffortSliderProps){return <Slider label="推理强度" value={value} min={0} max={Math.max(1,labels.length-1)} disabled={disabled||labels.length<2} onChange={onChange} onCommit={onCommit}/>;}
