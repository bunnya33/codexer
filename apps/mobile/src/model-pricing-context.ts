import { createContext, useContext } from 'react';
import { defaultModelPricing } from '../../../packages/shared/src/model-pricing';

export const ModelPricingContext = createContext(defaultModelPricing);
export const useModelPricing = () => useContext(ModelPricingContext);
