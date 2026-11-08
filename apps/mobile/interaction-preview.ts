import 'fast-text-encoding';
import { registerRootComponent } from 'expo';
import InteractionPreviewApp from './src/interaction-preview/app';

// A separate, explicit entry: production index.ts never imports this fixture.
registerRootComponent(InteractionPreviewApp);
