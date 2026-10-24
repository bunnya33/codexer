import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import {findNodeHandle, StyleSheet, View} from 'react-native';
import {request, subscribe} from '../bridge';
import type {ReactNode} from 'react';

export type ModalEntry = {id: string; content: ReactNode; close: () => void};
const ModalContext = createContext<{put: (entry: ModalEntry) => void; remove: (id: string) => void} | null>(null);
export const useModalHost = () => useContext(ModalContext);
function ModalLayer({entry, active, background}: {entry: ModalEntry; active: boolean; background: React.RefObject<View | null>}) {
  const view = useRef<View>(null);
  const current = useRef(entry);current.current=entry;
  useEffect(() => {
    if(!active)return;
    const off=subscribe('modalClose',()=>current.current.close());
    void request('window.modal',{tag:findNodeHandle(view.current),background:findNodeHandle(background.current)}).catch(()=>{});
    return () => {off();void request('window.modal',{}).catch(()=>{});};
  }, [active, background]);
  return <View ref={view} collapsable={false} accessibilityViewIsModal accessibilityElementsHidden={!active}
    pointerEvents={active ? 'auto' : 'none'} style={StyleSheet.absoluteFill}>
    {entry.content}
  </View>;
}
export function ModalHost({children}: {children: ReactNode}) {
  const background = useRef<View>(null);
  const [entries, setEntries] = useState<ModalEntry[]>([]);
  const api = useRef({
    put(entry: ModalEntry) {setEntries(previous => {
      const index = previous.findIndex(item => item.id === entry.id);
      return index < 0 ? [...previous, entry] : previous.map((item, i) => i === index ? entry : item);
    });},
    remove(id: string) {setEntries(previous => previous.filter(item => item.id !== id));},
  }).current;
  return <ModalContext.Provider value={api}><View style={{flex: 1}}>
    <View ref={background} collapsable={false} style={{flex: 1}} pointerEvents={entries.length ? 'none' : 'auto'} accessibilityElementsHidden={entries.length > 0}>{children}</View>
    {entries.map((entry, index) => <ModalLayer key={entry.id} entry={entry} background={background} active={index === entries.length - 1}/>)}
  </View></ModalContext.Provider>;
}
