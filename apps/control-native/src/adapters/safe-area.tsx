import React from 'react';
import {View, type ViewProps} from 'react-native';
export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});
export function SafeAreaView({edges:_edges,mode:_mode,...props}:ViewProps & {edges?:unknown;mode?:unknown}){return <View {...props}/>;}
export function SafeAreaProvider({style,...props}:ViewProps){return <View {...props} style={[{flex:1},style]}/>;}
