import type {ViewProps} from 'react-native';
import type {MessageTextRun} from '../../../packages/client-shared/src/message-text';
export type NativeMessageProps=ViewProps&{runs:MessageTextRun[];textColor:string;linkColor:string;userMessage?:boolean;bubbleColor?:string;menuTitle?:string;canEdit?:boolean;selectionRequest?:number;dismissSelectionRequest?:number;codeBlock?:boolean;onContentHeight:(event:{nativeEvent:{height:number;naturalWidth:number}})=>void;onAction?:(event:{nativeEvent:{action:string;href?:string}})=>void;onSelection?:(event:{nativeEvent:{active:boolean}})=>void};
