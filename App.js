import 'react-native-gesture-handler';
// GW Medidas 6.6.6 — overlay técnico da medição rápida
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Dimensions,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Line, Path, Rect, Text as SvgText, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import {
  gwCloudConfigured,
  gwGetSession,
  gwSignIn,
  gwSignOut,
  gwLoadWorkspaceProjects,
  mergeGwProjects,
  gwSendMeasurementToBudget,
  gwSendMeasurementToProject,
  gwCreateBudgetFromLocalMeasurement,
  gwSendExportSnapshot,
} from './gwIntegration';

const { width: RAW_W, height: RAW_H } = Dimensions.get('window');
const APP_W = Platform.OS === 'web' ? Math.min(440, RAW_W) : RAW_W;
const BLUE = '#1677F2';
const BLUE_SOFT = '#EAF3FF';
const INK = '#101820';
const MUTED = '#66758A';
const BG = '#F3F6F9';
const BORDER = '#D8E0E9';
const WHITE = '#FFFFFF';
const GRID = '#D5E0EB';
const STORE_KEY = 'gw-medidas-v15'; // mantém compatibilidade com medições já salvas

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const numFmt = (v) => Number(v || 0).toFixed(2).replace('.', ',');
const mFmt = (v) => `${numFmt(v)} m`;
const parseMeters = (s, fallback = 0) => {
  const n = Number(String(s).replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const normalizeVoiceText = value => String(value||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
const PT_UNITS={zero:0,um:1,uma:1,dois:2,duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12,treze:13,catorze:14,quatorze:14,quinze:15,dezesseis:16,dezessete:17,dezoito:18,dezenove:19};
const PT_TENS={vinte:20,trinta:30,quarenta:40,cinquenta:50,sessenta:60,setenta:70,oitenta:80,noventa:90};
const ptWordsNumber = text => {
  const t=normalizeVoiceText(text).replace(/\be\b/g,' '),tokens=t.split(/[^a-z0-9.,]+/).filter(Boolean); let total=0,found=false;
  for(const token of tokens){
    if(/^\d+(?:[.,]\d+)?$/.test(token)){const n=Number(token.replace(',','.'));if(Number.isFinite(n)){total+=n;found=true;}continue;}
    if(PT_UNITS[token]!=null){total+=PT_UNITS[token];found=true;continue;} if(PT_TENS[token]!=null){total+=PT_TENS[token];found=true;continue;}
    const h={cem:100,cento:100,duzentos:200,trezentos:300,quatrocentos:400,quinhentos:500}[token]; if(h!=null){total+=h;found=true;}
  } return found?total:null;
};
const spokenMeasureToMeters = raw => {
  const text=normalizeVoiceText(raw); if(!text)return null;
  const decimal=text.match(/(\d+[.,]\d+)\s*(?:m|metro|metros)?\b/); if(decimal){const n=Number(decimal[1].replace(',','.'));return Number.isFinite(n)?n:null;}
  const meterPart=text.match(/(.+?)\s*(?:metro|metros|\bm\b)(?:\s+e\s+(.+?)(?:\s*(?:centimetro|centimetros|cm)\b)?$)?/);
  if(meterPart){const meters=ptWordsNumber(meterPart[1]);const cm=meterPart[2]?ptWordsNumber(meterPart[2]):0;if(meters!=null)return meters+(cm||0)/100;}
  const cmMatch=text.match(/(.+?)\s*(?:centimetro|centimetros|cm)\b/); if(cmMatch){const cm=ptWordsNumber(cmMatch[1]);return cm!=null?cm/100:null;}
  const n=ptWordsNumber(text); if(n==null)return null; return n>10?n/100:n;
};
const extractVoiceMeasures = transcript => {
  const text=normalizeVoiceText(transcript),out={};
  const labels=[['width','largura'],['height','altura'],['depth','profundidade'],['thickness','espessura'],['left','da esquerda'],['left','esquerda'],['right','da direita'],['right','direita'],['bottom','do piso'],['bottom','piso'],['bottom','do chao'],['bottom','chao'],['top','do teto'],['top','teto']];
  for(const [key,label] of labels){const idx=text.indexOf(label);if(idx<0)continue;const start=idx+label.length;let end=text.length;for(const [,other] of labels){const j=text.indexOf(other,start+1);if(j>=0&&j<end)end=j;}const value=spokenMeasureToMeters(text.slice(start,end).replace(/^[\s,:;-]+/,''));if(value!=null&&value>=0&&value<=20)out[key]=value;}
  if(Object.keys(out).length===0&&text.includes(' por ')){const vals=text.split(/\s+por\s+/).map(spokenMeasureToMeters).filter(v=>v!=null);if(vals.length>=2){out.width=vals[0];if(vals.length===2)out.height=vals[1];else{out.depth=vals[1];out.height=vals[2];}}}
  return out;
};

const TECH = {
  wall:'#20262D', dim:'#556270', dimSoft:'#A8B2BD', opening:'#EAF3FF',
  equipment:'#EEF2F5', structure:'#DCE3E8', point:'#FFFFFF',
  selected:'#1677F2', floor:'#F5F2E8'
};
const RESERVED_SPACE_TYPES = ['Vão geladeira', 'Vão forno', 'Vão micro-ondas', 'Vão lava-louças', 'Vão máquina', 'Vão cooktop', 'Vão TV', 'Vão personalizado'];
const isReservedSpace = type => RESERVED_SPACE_TYPES.includes(type);
const isEquipment = type => GROUPS.find(g=>g.key==='Equipamentos')?.items.includes(type) && !isReservedSpace(type);
const isOpening = type => GROUPS.find(g=>g.key==='Aberturas')?.items.includes(type);
const isStructure = type => GROUPS.find(g=>g.key==='Estruturas')?.items.includes(type);
const isPoint = type => GROUPS.find(g=>g.key==='Pontos')?.items.includes(type);
const dimensionText = e => {
  const parts=[`L ${mFmt(e.width)}`,`A ${mFmt(e.height)}`];
  if(e.type==='Pia' && e.thickness!=null) parts.push(`E ${mFmt(e.thickness)}`);
  if((isEquipment(e.type)||isStructure(e.type)||isReservedSpace(e.type)||['Rodapé','Sanca'].includes(e.type)) && e.depth!=null) parts.push(`P ${mFmt(e.depth)}`);
  if(e.type==='Porta') parts.push(`abertura ${e.swing==='right'?'direita':'esquerda'}`);
  return parts.join(' · ');
};

const GROUPS = [
  { key: 'Aberturas', icon: '▱', items: ['Porta', 'Janela', 'Passagem', 'Nicho'] },
  { key: 'Pontos', icon: '⌁', items: ['Tomada', 'Interruptor', 'Água', 'Esgoto', 'Gás', 'TV/Dados'] },
  { key: 'Estruturas', icon: '▦', items: ['Pilar', 'Coluna', 'Shaft', 'Viga', 'Parede horizontal', 'Parede vertical'] },
  { key: 'Equipamentos', icon: '▣', items: ['Pia', 'Cuba', 'Geladeira', 'Frigobar', 'Freezer', 'Adega', 'Fogão', 'Cooktop', 'Forno', 'Micro-ondas', 'Lava-louças', 'Máquina de lavar', 'Secadora', 'Tanque', 'Coifa', 'Depurador', 'Ar-condicionado', 'Televisão', 'Mesa', 'Cadeira', 'Sofá', 'Poltrona', 'Rack', 'Aparador', 'Cama solteiro', 'Cama casal', 'Cama queen', 'Cama king', 'Beliche', 'Criado-mudo', 'Guarda-roupa', 'Outro', ...RESERVED_SPACE_TYPES] },
  { key: 'Acabamentos', icon: '⌜', items: ['Rodapé', 'Sanca'] },
];
const PLAN_GROUPS = ['Aberturas','Estruturas'];
const PLAN_ADD_GROUPS = ['Aberturas','Estruturas','Equipamentos'];
const FRONT_GROUPS = ['Pontos','Equipamentos','Acabamentos'];
const INTERNAL_WALL_TYPES = ['Parede horizontal','Parede vertical'];
const isInternalWall = type => INTERNAL_WALL_TYPES.includes(type);
const FREE_PLAN_TYPES = ['Mesa','Cadeira','Sofá','Poltrona','Rack','Aparador','Cama solteiro','Cama casal','Cama queen','Cama king','Beliche','Criado-mudo','Guarda-roupa'];
const isFreePlanType = type => FREE_PLAN_TYPES.includes(type);
// Parede interna: o vínculo é determinado pela borda do ambiente à qual ela está presa.
// A=topo, B=direita, C=base, D=esquerda. Isso corrige inclusive paredes criadas
// em versões anteriores, onde o campo wall podia ter ficado gravado incorretamente.
const resolvedInternalWallIndex = (e,room) => {
  if(!isInternalWall(e?.type)) return Number(e?.wall)||0;
  const count=Math.max(1,Number(room?.wallCount||4));
  const stored=Number(e?.wall);
  if(Number.isFinite(stored)&&stored>=0&&stored<count) return stored;
  // Compatibilidade com paredes internas antigas, salvas como elemento livre.
  const fx=clamp(Number.isFinite(e?.freeX)?Number(e.freeX):.5,.05,.95);
  const fy=clamp(Number.isFinite(e?.freeY)?Number(e.freeY):.58,.08,.92);
  if(e?.type==='Parede vertical') return count>=3?(fy>=.5?2:0):0;
  return count>=4?(fx>=.5?1:3):(count>=2?1:0);
};
const elementWallIndex = (e,room) => isInternalWall(e?.type)?resolvedInternalWallIndex(e,room):(Number(e?.wall)||0);
const internalWallThickness = e => {
  const raw=e?.type==='Parede vertical'?Number(e?.width||.10):Number(e?.depth||.10);
  return clamp(raw,.06,.18);
};
const internalWallFrontLeft = (e,wallIndex,room) => {
  // A parede interna já é ancorada e movimentada pelo campo `left` na Planta.
  // A vista frontal precisa usar EXATAMENTE a mesma coordenada; usar freeX/freeY
  // fazia a projeção aparecer em outro ponto (normalmente no meio da parede).
  const wallW=(room?.lengths||[])[wallIndex]||3.2, t=internalWallThickness(e);
  return clamp(Number(e?.left||0),0,Math.max(0,wallW-t));
};
const frontObjectForRoom = (e,wallIndex,room) => isInternalWall(e?.type)
  ? {...e,wall:wallIndex,width:internalWallThickness(e),height:room?.height||2.65,bottom:0,left:internalWallFrontLeft(e,wallIndex,room),_internalProjection:true}
  : e;

const alongWallWidth = e => isInternalWall(e?.type)?internalWallThickness(e):Number(e?.width||0);
const wallAvailableSegments = (room,wallIndex) => {
  const wallW=Number(room?.lengths?.[wallIndex]||0);
  if(!(wallW>0)) return [{start:0,end:0,width:0}];
  const blockers=(room?.elements||[])
    .filter(e=>isInternalWall(e?.type)&&elementWallIndex(e,room)===wallIndex)
    .map(e=>{const t=internalWallThickness(e),start=clamp(Number(e.left||0),0,Math.max(0,wallW-t));return {start,end:start+t};})
    .sort((a,b)=>a.start-b.start);
  const out=[];let cursor=0;
  blockers.forEach(b=>{if(b.start-cursor>.03)out.push({start:cursor,end:b.start,width:b.start-cursor});cursor=Math.max(cursor,b.end)});
  if(wallW-cursor>.03)out.push({start:cursor,end:wallW,width:wallW-cursor});
  return out.length?out:[{start:0,end:wallW,width:wallW}];
};
const wallSegmentForElement = (room,e) => {
  const wi=elementWallIndex(e,room), wallW=Number(room?.lengths?.[wi]||0);
  if(!e||isInternalWall(e?.type)||isFreePlanType(e?.type)||e?.free===true||!(wallW>0)) return {start:0,end:wallW,width:wallW,wallIndex:wi};
  const segments=wallAvailableSegments(room,wi), width=Math.max(.02,Number(e.width||0)), center=Number(e.left||0)+width/2;
  let seg=segments.find(x=>center>=x.start-.001&&center<=x.end+.001);
  if(!seg||seg.width<width) seg=segments.filter(x=>x.width>=width).sort((a,b)=>b.width-a.width)[0]||segments.sort((a,b)=>b.width-a.width)[0];
  return {...seg,wallIndex:wi};
};
const constrainElementToWallSegments = (room,e) => {
  if(!e||isInternalWall(e.type)||isFreePlanType(e.type)||e.free===true) return e;
  const seg=wallSegmentForElement(room,e), width=Math.max(.02,Number(e.width||0));
  if(!(seg.width>0)) return e;
  const maxLeft=Math.max(seg.start,seg.end-width);
  return {...e,wall:seg.wallIndex,left:clamp(Number(e.left||0),seg.start,maxLeft)};
};
const visualLayer = e => isInternalWall(e?.type)?8:(Number.isFinite(Number(e?.layer)) ? Number(e.layer) : ((GROUPS.find(g=>g.key==='Acabamentos')?.items||[]).includes(e?.type)?0:(isEquipment(e?.type)?2:1)));

const DEFAULTS = {
  Porta: { width: .80, height: 2.10, bottom: 0, swing: 'left' },
  Janela: { width: 1.20, height: 1.00, bottom: 1.10 },
  Passagem: { width: .90, height: 2.10, bottom: 0 },
  Nicho: { width: .60, height: .40, bottom: 1.20 },
  Tomada: { width: .08, height: .08, bottom: .35 },
  Interruptor: { width: .08, height: .12, bottom: 1.10 },
  Água: { width: .08, height: .08, bottom: .60 },
  Esgoto: { width: .10, height: .10, bottom: .30 },
  Gás: { width: .08, height: .08, bottom: .60 },
  'TV/Dados': { width: .08, height: .08, bottom: 1.20 },
  Pilar: { width: .25, height: 2.65, bottom: 0, depth: .25 },
  Coluna: { width: .20, height: 2.65, bottom: 0, depth: .20 },
  Shaft: { width: .35, height: 2.65, bottom: 0, depth: .25 },
  Viga: { width: 1.20, height: .25, bottom: 2.40, depth: .20 },
  'Parede horizontal': { width: 1.50, height: 2.65, bottom: 0, depth: .10 },
  'Parede vertical': { width: .10, height: 2.65, bottom: 0, depth: 1.50 },
  Pia: { width: 1.20, height: .20, bottom: .90, depth: .60, thickness: .03 },
  Geladeira: { width: .70, height: 1.85, bottom: 0, depth: .70 },
  Fogão: { width: .60, height: .90, bottom: 0, depth: .60 },
  Cooktop: { width: .60, height: .08, bottom: .90, depth: .52 },
  Forno: { width: .60, height: .60, bottom: .70, depth: .58 },
  'Micro-ondas': { width: .55, height: .32, bottom: 1.40, depth: .40 },
  'Lava-louças': { width: .60, height: .85, bottom: 0, depth: .60 },
  'Máquina de lavar': { width: .65, height: .95, bottom: 0, depth: .65 },
  Tanque: { width: .60, height: .90, bottom: 0, depth: .50 },
  Coifa: { width: .60, height: .45, bottom: 1.70, depth: .45 },
  'Cama solteiro': { width: .90, height: .55, bottom: 0, depth: 1.90 },
  'Cama casal': { width: 1.40, height: .55, bottom: 0, depth: 1.90 },
  Beliche: { width: .90, height: 1.70, bottom: 0, depth: 1.90 },
  'Televisão': { width: 1.10, height: .65, bottom: 1.05, depth: .06 },
  Mesa: { width: 1.20, height: .75, bottom: 0, depth: .80 },
  'Sofá': { width: 2.00, height: .85, bottom: 0, depth: .90 },
  'Poltrona': { width: .85, height: .85, bottom: 0, depth: .85 },
  'Cadeira': { width: .48, height: .90, bottom: 0, depth: .52 },
  'Rack': { width: 1.80, height: .55, bottom: 0, depth: .40 },
  'Aparador': { width: 1.20, height: .80, bottom: 0, depth: .38 },
  'Cama queen': { width: 1.58, height: .55, bottom: 0, depth: 1.98 },
  'Cama king': { width: 1.93, height: .55, bottom: 0, depth: 2.03 },
  'Criado-mudo': { width: .50, height: .55, bottom: 0, depth: .40 },
  'Guarda-roupa': { width: 1.80, height: 2.30, bottom: 0, depth: .60 },
  Outro: { width: .60, height: .60, bottom: 0, depth: .50 },
  Rodapé: { width: 1.20, height: .10, bottom: 0, depth: .02 },
  'Vão geladeira': { width: .80, height: 1.90, bottom: 0, depth: .75 },
  'Vão forno': { width: .62, height: .62, bottom: .65, depth: .60 },
  'Vão micro-ondas': { width: .60, height: .40, bottom: 1.35, depth: .45 },
  'Vão lava-louças': { width: .62, height: .88, bottom: 0, depth: .62 },
  'Vão máquina': { width: .70, height: 1.00, bottom: 0, depth: .70 },
  'Vão cooktop': { width: .65, height: .12, bottom: .88, depth: .55 },
  'Vão TV': { width: 1.20, height: .75, bottom: 1.00, depth: .10 },
  'Vão personalizado': { width: .60, height: .60, bottom: 0, depth: .50 },
  Cuba: { width: .55, height: .22, bottom: .88, depth: .45 },
  Frigobar: { width: .50, height: .85, bottom: 0, depth: .52 },
  Freezer: { width: .70, height: .85, bottom: 0, depth: .70 },
  Adega: { width: .50, height: .85, bottom: 0, depth: .55 },
  Secadora: { width: .65, height: .85, bottom: 0, depth: .65 },
  Depurador: { width: .60, height: .18, bottom: 1.65, depth: .32 },
  'Ar-condicionado': { width: .90, height: .30, bottom: 2.05, depth: .22 },
  Sanca: { width: 1.20, height: .15, bottom: 2.50, depth: .15 },
};

const ICONS = {
  Porta: '🚪', Janela: '▤', Passagem: '▯', Nicho: '□',
  Tomada: '🔌', Interruptor: '◉', Água: '💧', Esgoto: '◍', Gás: '🔥', 'TV/Dados': '▣',
  Pilar: '▰', Coluna: '▮', Shaft: '▧', Viga: '▬', 'Parede horizontal':'━', 'Parede vertical':'┃',
  Pia: '⌑', Geladeira: '▥', Fogão: '▤', Cooktop: '▱', 'Fogão/Cooktop': '◉', Forno: '▣', 'Micro-ondas': '▭', 'Lava-louças': '▦', 'Máquina de lavar': '◉', Tanque: '∪', Coifa: '⌂', 'Cama solteiro':'▱', 'Cama casal':'▰', Beliche:'▥', 'Televisão':'▭', Mesa:'▤', 'Sofá':'▰', 'Poltrona':'▣', 'Cadeira':'♢', 'Rack':'▬', 'Aparador':'▭', 'Cama queen':'▰', 'Cama king':'▰', 'Criado-mudo':'□', 'Guarda-roupa':'▥', Cuba:'⌒', Frigobar:'▥', Freezer:'▰', Adega:'▦', Secadora:'◉', Depurador:'▬', 'Ar-condicionado':'▭', 'Vão geladeira':'⬚', 'Vão forno':'⬚', 'Vão micro-ondas':'⬚', 'Vão lava-louças':'⬚', 'Vão máquina':'⬚', 'Vão cooktop':'⬚', 'Vão TV':'⬚', 'Vão personalizado':'⬚', Outro:'□', Rodapé:'▬', Sanca:'⌜',
};

function AppFrame({ children }) {
  return <View style={styles.webOuter}><View style={styles.appFrame}>{children}</View></View>;
}
function Button({ title, onPress, secondary = false, disabled = false, compact = false }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.btn, secondary && styles.btnSecondary, compact && styles.btnCompact, pressed && { opacity: .78 }, disabled && { opacity: .42 }]}><Text style={[styles.btnText, secondary && styles.btnTextSecondary]}>{title}</Text></Pressable>;
}
function Header({ title, subtitle, onBack, right }) {
  return <View style={styles.header}><View style={{ flex: 1 }}>{onBack ? <Pressable onPress={onBack} hitSlop={12}><Text style={styles.back}>‹ Voltar</Text></Pressable> : null}<Text style={styles.headerTitle}>{title}</Text>{subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}</View>{right}</View>;
}
function Field({ label, value, onChangeText, placeholder }) {
  return <View><Text style={styles.label}>{label}</Text><TextInput style={styles.input} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor="#9AA6B5" /></View>;
}

function Welcome({ onStart }) {
  return <View style={styles.welcome}><StatusBar barStyle="light-content" />
    <View style={styles.welcomeGlow}/>
    <View style={styles.welcomeLogoWrap}><Text style={styles.welcomeGW}>GW</Text><Text style={styles.welcomeMedidas}>M E D I D A S</Text></View>
    <Text style={styles.welcomePromise}>Medições mais simples.{`\n`}Projetos mais precisos.</Text>
    <View style={styles.welcomeActions}><Pressable onPress={onStart} style={styles.welcomePrimary}><Text style={styles.welcomePrimaryText}>Começar agora</Text></Pressable><Pressable onPress={onStart} style={styles.welcomeSecondary}><Text style={styles.welcomeSecondaryText}>Já tenho uma conta</Text></Pressable><Text style={styles.welcomeFree}>100% gratuito para começar</Text></View>
    <View style={styles.welcomeBottom}><View style={styles.welcomeLine}/><Text style={styles.welcomeBottomText}>Da medição ao projeto.{`\n`}Tudo no seu fluxo.</Text></View>
  </View>;
}

function MainBottomNav({active='home',onHome,onProjects,onClients,onMore}){
  const items=[['home','⌂','Início',onHome],['projects','▣','Projetos',onProjects],['clients','♙','Clientes',onClients],['more','•••','Mais',onMore]];
  return <View style={styles.bottomNav}>{items.map(([key,icon,label,fn])=><Pressable key={key} onPress={fn} style={styles.bottomNavItem}><Text style={active===key?styles.bottomNavIconOn:styles.bottomNavIcon}>{icon}</Text><Text style={active===key?styles.bottomNavTextOn:styles.bottomNavText}>{label}</Text></Pressable>)}</View>
}

function Home({ onQuick, onNew, onProjects, onClients, onHelp, onMore }) {
  const [menuOpen,setMenuOpen]=useState(false);
  return <View style={styles.screen}>
    <View style={styles.projectsHeader}><Pressable onPress={()=>setMenuOpen(true)} hitSlop={10} style={styles.projectsMenuBtn}><Text style={styles.projectsMenu}>☰</Text></Pressable><View style={{flex:1}}><Text style={[styles.projectsHeaderTitle,{textAlign:'left'}]}>GW Medidas</Text><Text style={styles.homeHeaderSub}>Escolha como deseja fazer o levantamento</Text></View><View style={{width:38}}/></View>
    <ScrollView style={{flex:1}} contentContainerStyle={styles.homeCleanBody} showsVerticalScrollIndicator={false}>
      <View style={styles.homeHero}><Text style={styles.homeHeroEyebrow}>NOVO LEVANTAMENTO</Text><Text style={styles.homeHeroTitle}>Como você quer medir?</Text><Text style={styles.homeHeroText}>Escolha o modo ideal para o serviço de hoje.</Text></View>
      <View style={styles.homeModeStack}>
        <Pressable onPress={onQuick} style={[styles.homeChoiceCard,styles.homeChoiceQuick]}><View style={[styles.homeChoiceIcon,styles.homeChoiceIconQuick]}><Text style={styles.homeChoiceIconText}>⚡</Text></View><View style={{flex:1}}><Text style={styles.homeChoiceTitle}>Medição rápida</Text><Text style={styles.homeChoiceText}>Fotografe, puxe a cota e registre a medida direto na imagem.</Text><Text style={styles.homeChoiceHint}>Foto  →  cota  →  salvar</Text></View><Text style={styles.homeChoiceArrow}>›</Text></Pressable>
        <Pressable onPress={onNew} style={styles.homeChoiceCard}><View style={styles.homeChoiceIcon}><Text style={styles.homeChoiceIconText}>⌗</Text></View><View style={{flex:1}}><Text style={styles.homeChoiceTitle}>Medição completa</Text><Text style={styles.homeChoiceText}>Planta, paredes, equipamentos, pontos, fotos e levantamento técnico.</Text><Text style={styles.homeChoiceHint}>Levantamento completo</Text></View><Text style={styles.homeChoiceArrow}>›</Text></Pressable>
      </View>

    </ScrollView>
    <MainBottomNav active="home" onHome={()=>{}} onProjects={onProjects} onClients={onClients} onMore={onMore}/>
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={()=>setMenuOpen(false)}><View style={styles.menuBackdrop}><Pressable style={StyleSheet.absoluteFillObject} onPress={()=>setMenuOpen(false)}/><View style={styles.sideMenu}><Text style={styles.sideMenuTitle}>GW Medidas</Text><Text style={styles.sideMenuSub}>Navegação</Text><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onQuick?.()}}><Text style={styles.sideMenuItemText}>⚡ Medição rápida</Text></Pressable><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onNew?.()}}><Text style={styles.sideMenuItemText}>⌗ Medição completa</Text></Pressable><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onProjects?.()}}><Text style={styles.sideMenuItemText}>▣ Projetos</Text></Pressable><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onClients?.()}}><Text style={styles.sideMenuItemText}>♙ Clientes</Text></Pressable><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onHelp?.()}}><Text style={styles.sideMenuItemText}>? Ajuda</Text></Pressable><Pressable style={styles.sideMenuItem} onPress={()=>{setMenuOpen(false);onMore?.()}}><Text style={styles.sideMenuItemText}>••• Mais</Text></Pressable></View></View></Modal>
  </View>;
}

function ProjectsLibrary({projects,quickJobs=[],onBack,onHome,onOpen,onOpenQuick,onDelete,onClients,onMore}){
  const [query,setQuery]=useState('');
  const rows=[
    ...quickJobs.map(q=>({kind:'quick',id:q.id,client:q.client||'Sem cliente',project:q.project||'Medição rápida',date:q.updatedAt||q.createdAt||0,photo:q.photos?.[0]?.uri,photos:q.photos?.length||0,raw:q})),
    ...projects.map(p=>({kind:'complete',id:p.id,client:p.client||'Sem cliente',project:p.name||'Projeto',date:p.updatedAt||p.createdAt||0,photo:(p.rooms||[]).flatMap(r=>r.photos||[])[0]?.uri,rooms:p.rooms?.length||0,raw:p}))
  ].sort((a,b)=>b.date-a.date).filter(r=>`${r.client} ${r.project}`.toLowerCase().includes(query.toLowerCase()));
  return <View style={styles.screen}>
    <View style={styles.projectsHeader}><Pressable onPress={onBack} hitSlop={10} style={styles.projectsMenuBtn}><Text style={styles.simpleBack}>‹</Text></Pressable><Text style={styles.projectsHeaderTitle}>Projetos</Text><Pressable onPress={onHome} style={styles.projectsHomeBtn}><Text style={styles.projectsHomeBtnText}>⌂</Text></Pressable></View>
    <View style={styles.projectsIntro}><Text style={styles.projectsIntroTitle}>Seus levantamentos</Text><Text style={styles.projectsIntroText}>Encontre primeiro pelo cliente e reconheça o serviço pela foto ou planta.</Text></View>
    <View style={styles.searchBox}><Text style={styles.searchIcon}>⌕</Text><TextInput value={query} onChangeText={setQuery} placeholder="Buscar cliente ou projeto..." placeholderTextColor="#8B94A2" style={styles.searchInput}/></View>
    <ScrollView style={{flex:1}} contentContainerStyle={styles.projectsLibraryList} showsVerticalScrollIndicator={false}>
      {rows.length?rows.map(r=><View key={`${r.kind}-${r.id}`} style={styles.libraryCard}><Pressable onPress={()=>r.kind==='quick'?onOpenQuick(r.id):onOpen(r.id)} style={styles.libraryCardOpen}><View style={styles.libraryThumb}>{r.photo?<Image source={{uri:r.photo}} style={StyleSheet.absoluteFillObject} resizeMode="cover"/>:<View style={styles.planMini}><View style={styles.planMiniRoom}/><View style={styles.planMiniLine}/><Text style={styles.planMiniText}>PLANTA</Text></View>}</View><View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={styles.libraryClient}>{r.client}</Text><Text numberOfLines={1} style={styles.libraryProject}>{r.project}</Text><View style={styles.libraryMetaRow}><View style={[styles.libraryTypePill,r.kind==='quick'&&styles.libraryTypeQuick]}><Text style={[styles.libraryTypeText,r.kind==='quick'&&styles.libraryTypeQuickText]}>{r.kind==='quick'?'Medição rápida':'Medição completa'}</Text></View><Text style={styles.libraryCount}>{r.kind==='quick'?`${r.photos} foto${r.photos!==1?'s':''}`:`${r.rooms} ambiente${r.rooms!==1?'s':''}`}</Text></View></View><Text style={styles.chevSmall}>›</Text></Pressable>{r.kind==='complete'?<Pressable hitSlop={8} onPress={()=>onDelete(r.id)} style={styles.libraryDelete}><Text style={styles.deleteIconText}>×</Text></Pressable>:null}</View>):<View style={styles.emptyHome}><Text style={styles.emptyHomeIcon}>▣</Text><Text style={styles.emptyHomeTitle}>Nenhum projeto salvo</Text><Text style={styles.emptyHomeText}>As medições rápidas e completas aparecerão aqui.</Text></View>}
    </ScrollView>
    <MainBottomNav active="projects" onHome={onHome} onProjects={()=>{}} onClients={onClients} onMore={onMore}/>
  </View>
}

function NewMeasurement({ projects, onBack, onContinue }) {
  const [client,setClient]=useState(''); const [project,setProject]=useState(''); const [room,setRoom]=useState('Cozinha'); const [kind,setKind]=useState('Cozinha'); const [existing,setExisting]=useState(null); const [roomAuto,setRoomAuto]=useState(true);
  const chooseExisting=p=>{setExisting(p.id);setClient(p.client);setProject(p.name)}; const ready=client.trim()&&project.trim()&&room.trim();
  const kinds=[['▦','Cozinha'],['▱','Dormitório'],['♨','Banheiro'],['▤','Sala'],['▧','Área de serviço'],['•••','Outro']];
  return <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled"><View style={styles.simpleTop}><Pressable onPress={onBack}><Text style={styles.simpleBack}>‹</Text></Pressable><Text style={styles.simpleTopTitle}>Novo ambiente</Text><View style={{width:30}}/></View><View style={styles.newEnvPad}>
    {projects.length?<><Text style={styles.newEnvLabel}>Medição existente (opcional)</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8}}>{projects.map(p=><Pressable key={p.id} onPress={()=>chooseExisting(p)} style={[styles.existingChip,existing===p.id&&styles.existingChipOn]}><Text style={[styles.existingChipText,existing===p.id&&{color:BLUE}]}>{p.client} · {p.name}</Text></Pressable>)}</ScrollView></>:null}
    <Field label="Cliente" value={client} onChangeText={v=>{setClient(v);setExisting(null)}} placeholder="Ex.: João Silva"/><Field label="Projeto" value={project} onChangeText={v=>{setProject(v);setExisting(null)}} placeholder="Ex.: Cozinha - Cliente João"/><Field label="Nome do ambiente" value={room} onChangeText={v=>{setRoom(v);setRoomAuto(false)}} placeholder="Cozinha"/>
    <Text style={styles.newEnvLabel}>Tipo de ambiente (opcional)</Text><View style={styles.roomTypeGrid}>{kinds.map(([ic,n])=><Pressable key={n} onPress={()=>{setKind(n);if(roomAuto||!room.trim()){setRoom(n==='Outro'?'':n);setRoomAuto(n!=='Outro')}}} style={[styles.roomTypeCard,kind===n&&styles.roomTypeCardOn]}><Text style={[styles.roomTypeIcon,kind===n&&{color:BLUE}]}>{ic}</Text><Text style={[styles.roomTypeText,kind===n&&{color:BLUE}]}>{n}</Text></Pressable>)}</View>
    <Pressable disabled={!ready} onPress={()=>onContinue({client:client.trim(),project:project.trim(),room:room.trim(),roomType:kind,projectId:existing,suggestedWallCount:4})} style={[styles.createEnvBtn,!ready&&{opacity:.4}]}><Text style={styles.createEnvText}>Criar ambiente</Text></Pressable>
  </View></ScrollView>;
}

function WallCount({ meta, onBack, onChoose }) {
  const options = [{n:1,label:'1 parede',shape:'—'},{n:2,label:'2 paredes',shape:'⌞'},{n:3,label:'3 paredes',shape:'⊔'},{n:4,label:'4 paredes',shape:'□'}];
  return <View style={styles.screen}><Header title={meta.room} subtitle={`${meta.client} · ${meta.project}`} onBack={onBack} /><View style={styles.wallChoiceWrap}><Text style={styles.sectionKicker}>COMO É ESTE AMBIENTE?</Text><Text style={styles.wallChoiceTitle}>Escolha quantas paredes quer medir agora.</Text><View style={styles.floorPreview}><GridBackground /><Text style={styles.floorPreviewText}>Piso / vista superior</Text></View><View style={styles.wallCountRow}>{options.map(o=><Pressable key={o.n} onPress={()=>onChoose(o.n)} style={styles.wallCountCard}><Text style={styles.wallShape}>{o.shape}</Text><Text style={styles.wallCountText}>{o.label}</Text></Pressable>)}</View><Text style={styles.wallChoiceHint}>Você pode salvar com uma parede só ou continuar detalhando todo o ambiente.</Text></View></View>;
}

function GridBackground({ step=22 }) {
  const w = APP_W-24, h=520; const lines=[];
  for(let x=0;x<w;x+=step) lines.push(<Line key={`x${x}`} x1={x} y1={0} x2={x} y2={h} stroke={GRID} strokeWidth="1"/>);
  for(let y=0;y<h;y+=step) lines.push(<Line key={`y${y}`} x1={0} y1={y} x2={w} y2={y} stroke={GRID} strokeWidth="1"/>);
  return <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">{lines}</Svg>;
}

function deriveWalls(count, lengths, w, h) {
  const n=clamp(Number(count)||1,1,4);
  const safeLengths=Array.from({length:n},(_,i)=>{const v=Number(Array.isArray(lengths)?lengths[i]:0);return Number.isFinite(v)&&v>0?v:(i%2===0?3.2:2.8)});
  count=n; lengths=safeLengths;
  const cx=w/2, cy=h/2; const maxW=w*.82, maxH=h*.70;
  const sx=Math.min(maxW/Math.max(lengths[0]||1,lengths[2]||1), maxH/Math.max(lengths[1]||1,lengths[3]||1), 95);
  const L=i=>(lengths[i]||2.5)*sx;
  if(count===1){ const a={x:cx-L(0)/2,y:cy}, b={x:cx+L(0)/2,y:cy}; return [{a,b,index:0,length:lengths[0]}]; }
  if(count===2){ const p0={x:cx-L(0)/2,y:cy-L(1)/2}, p1={x:p0.x+L(0),y:p0.y}, p2={x:p1.x,y:p1.y+L(1)}; return [{a:p0,b:p1,index:0,length:lengths[0]},{a:p1,b:p2,index:1,length:lengths[1]}]; }
  if(count===3){ const top=L(0), right=L(1), left=L(2); const hh=Math.max(right,left); const p0={x:cx-top/2,y:cy-hh/2},p1={x:cx+top/2,y:cy-hh/2},p2={x:p1.x,y:p1.y+right},p3={x:p0.x,y:p0.y+left}; return [{a:p0,b:p1,index:0,length:lengths[0]},{a:p1,b:p2,index:1,length:lengths[1]},{a:p3,b:p0,index:2,length:lengths[2]}]; }
  const top=L(0), right=L(1), bottom=L(2), left=L(3); const ww=(top+bottom)/2, hh=(right+left)/2; const p0={x:cx-ww/2,y:cy-hh/2},p1={x:cx+ww/2,y:cy-hh/2},p2={x:cx+ww/2,y:cy+hh/2},p3={x:cx-ww/2,y:cy+hh/2}; return [{a:p0,b:p1,index:0,length:lengths[0]},{a:p1,b:p2,index:1,length:lengths[1]},{a:p2,b:p3,index:2,length:lengths[2]},{a:p3,b:p0,index:3,length:lengths[3]}];
}


function PlanWallDimensions({walls,activeIndex,selectedElement,onChooseWall,onEditWall,width,height}){
  if(!walls?.length)return null;
  const pts=walls.flatMap(w=>[w.a,w.b]),cx=pts.reduce((a,p)=>a+p.x,0)/Math.max(1,pts.length),cy=pts.reduce((a,p)=>a+p.y,0)/Math.max(1,pts.length);
  return <Svg style={StyleSheet.absoluteFillObject} width={width} height={height} pointerEvents="box-none">
    {walls.map((w,i)=>{
      const dx=w.b.x-w.a.x,dy=w.b.y-w.a.y,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L;
      let nx=-uy,ny=ux,mx=(w.a.x+w.b.x)/2,my=(w.a.y+w.b.y)/2;
      if((mx+nx*20-cx)**2+(my+ny*20-cy)**2 < (mx-nx*20-cx)**2+(my-ny*20-cy)**2){nx=-nx;ny=-ny}
      const active=!selectedElement&&activeIndex===i, off=active?28:24;
      const a={x:w.a.x+nx*off,y:w.a.y+ny*off},b={x:w.b.x+nx*off,y:w.b.y+ny*off},tx=(a.x+b.x)/2,ty=(a.y+b.y)/2;
      const insideX=mx-nx*17,insideY=my-ny*17, dim=active?BLUE:'#485968', ext='#9AA8B5';
      const rot=Math.atan2(dy,dx)*180/Math.PI;
      return <React.Fragment key={`dim-${i}`}>
        <Line x1={w.a.x} y1={w.a.y} x2={a.x} y2={a.y} stroke={ext} strokeWidth=".75"/>
        <Line x1={w.b.x} y1={w.b.y} x2={b.x} y2={b.y} stroke={ext} strokeWidth=".75"/>
        <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={dim} strokeWidth={active?1.5:1.05}/>
        <Line x1={a.x-ny*4} y1={a.y+nx*4} x2={a.x+ny*4} y2={a.y-nx*4} stroke={dim} strokeWidth="1.1"/>
        <Line x1={b.x-ny*4} y1={b.y+nx*4} x2={b.x+ny*4} y2={b.y-nx*4} stroke={dim} strokeWidth="1.1"/>
        <Rect x={tx-25} y={ty-8} width="50" height="16" rx="5" fill="#FFFFFF" stroke={active?'#B8D4FF':'#E2E8EE'} strokeWidth=".6"/>
        <SvgText x={tx} y={ty+3} fontSize="9.5" fontWeight="800" fill={dim} textAnchor="middle" transform={`rotate(${Math.abs(rot)>90?rot+180:rot} ${tx} ${ty})`} onPress={()=>{if(onChooseWall)onChooseWall(i);if(onEditWall)onEditWall(i)}}>{numFmt(w.length)} m</SvgText>
        <Rect x={insideX-22} y={insideY-7} width="44" height="14" rx="4" fill="rgba(255,255,255,.86)"/>
        <SvgText x={insideX} y={insideY+3} fontSize="7.8" fontWeight="800" fill={active?BLUE:'#657483'} textAnchor="middle">Parede {String.fromCharCode(65+i)}</SvgText>
      </React.Fragment>
    })}
  </Svg>;
}

function PlanSelectedWallSegments({wall,wallLength,elements=[],walls=[],width,height}){
  if(!wall||!wallLength)return null;
  const dx=wall.b.x-wall.a.x,dy=wall.b.y-wall.a.y,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L;
  let nx=-uy,ny=ux; const mx=(wall.a.x+wall.b.x)/2,my=(wall.a.y+wall.b.y)/2;
  const pts=(walls?.length?walls:[wall]).flatMap(w=>[w.a,w.b]);
  const cx=pts.reduce((a,p)=>a+p.x,0)/Math.max(1,pts.length),cy=pts.reduce((a,p)=>a+p.y,0)/Math.max(1,pts.length);
  if((mx+nx*20-cx)**2+(my+ny*20-cy)**2 < (mx-nx*20-cx)**2+(my-ny*20-cy)**2){nx=-nx;ny=-ny}
  const relevant=elements.filter(e=>Number(e.wall)===Number(wall.index));
  if(!relevant.length)return null;
  const cuts=[0,wallLength]; relevant.forEach(e=>{const aw=alongWallWidth(e);cuts.push(clamp(e.left||0,0,wallLength));cuts.push(clamp((e.left||0)+aw,0,wallLength))});
  const vals=[...new Set(cuts.map(v=>Math.round(v*1000)/1000))].sort((a,b)=>a-b);
  const off=42, extensionStart=7, ext='#A6B3BE', dim='#7F91A1';
  return <Svg style={StyleSheet.absoluteFillObject} width={width} height={height} pointerEvents="none">
    {vals.slice(0,-1).map((v,i)=>{
      const v2=vals[i+1],seg=v2-v;if(seg<.08)return null;
      const p1={x:wall.a.x+ux*(v/wallLength)*L,y:wall.a.y+uy*(v/wallLength)*L};
      const p2={x:wall.a.x+ux*(v2/wallLength)*L,y:wall.a.y+uy*(v2/wallLength)*L};
      const a={x:p1.x+nx*off,y:p1.y+ny*off};
      const b={x:p2.x+nx*off,y:p2.y+ny*off};
      const tx=(a.x+b.x)/2,ty=(a.y+b.y)/2;
      return <React.Fragment key={`seg-${i}`}>
        <Line x1={p1.x+nx*extensionStart} y1={p1.y+ny*extensionStart} x2={a.x} y2={a.y} stroke={ext} strokeWidth=".65"/>
        <Line x1={p2.x+nx*extensionStart} y1={p2.y+ny*extensionStart} x2={b.x} y2={b.y} stroke={ext} strokeWidth=".65"/>
        <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={dim} strokeWidth=".8"/>
        <Line x1={a.x-ny*3} y1={a.y+nx*3} x2={a.x+ny*3} y2={a.y-nx*3} stroke={dim} strokeWidth=".8"/>
        <Line x1={b.x-ny*3} y1={b.y+nx*3} x2={b.x+ny*3} y2={b.y-nx*3} stroke={dim} strokeWidth=".8"/>
        <Rect x={tx-16} y={ty-6} width="32" height="12" rx="4" fill="rgba(255,255,255,.94)"/>
        <SvgText x={tx} y={ty+2.5} textAnchor="middle" fontSize="7.2" fontWeight="700" fill="#536473">{numFmt(seg)}</SvgText>
      </React.Fragment>;
    })}
  </Svg>;
}

function FrontSegmentDimensions({objects,wallW,px,width,height}){
  if(!objects?.length)return null;
  const x=27,y=14,wallTop=46;
  const cuts=[0,wallW];
  objects.filter(e=>isOpening(e.type)||isEquipment(e.type)||isStructure(e.type)||isReservedSpace(e.type)).forEach(e=>{cuts.push(clamp(e.left||0,0,wallW));cuts.push(clamp((e.left||0)+(e.width||0),0,wallW))});
  const vals=[...new Set(cuts.map(v=>Math.round(v*1000)/1000))].sort((a,b)=>a-b);
  return <Svg width={width} height={height} style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
    {vals.slice(0,-1).map((v,i)=>{
      const b=vals[i+1],seg=b-v;if(seg<.08)return null;
      const x1=x+v*px,x2=x+b*px,c=(x1+x2)/2;
      return <React.Fragment key={`fd-${i}`}>
        <Line x1={x1} y1={wallTop} x2={x1} y2={y} stroke="#A6B3BE" strokeWidth=".65"/>
        <Line x1={x2} y1={wallTop} x2={x2} y2={y} stroke="#A6B3BE" strokeWidth=".65"/>
        <Line x1={x1} y1={y} x2={x2} y2={y} stroke="#718496" strokeWidth=".8"/>
        <Line x1={x1} y1={y-4} x2={x1} y2={y+4} stroke="#718496" strokeWidth=".8"/>
        <Line x1={x2} y1={y-4} x2={x2} y2={y+4} stroke="#718496" strokeWidth=".8"/>
        <Rect x={c-15} y={y-6} width="30" height="12" rx="4" fill="#FFFFFF"/>
        <SvgText x={c} y={y+2.5} textAnchor="middle" fontSize="6.8" fontWeight="700" fill="#4A5A68">{numFmt(seg)}</SvgText>
      </React.Fragment>;
    })}
  </Svg>;
}


function PlanTechnicalLayer({walls,room,selected,selectedElement,canvasFree,onChooseWall,onEditWall,width,height,focusedCota=null,onFocusCota}){
  if(!walls?.length)return null;
  const pts=walls.flatMap(w=>[w.a,w.b]);
  const cx=pts.reduce((a,p)=>a+p.x,0)/Math.max(1,pts.length),cy=pts.reduce((a,p)=>a+p.y,0)/Math.max(1,pts.length);
  return <Svg style={StyleSheet.absoluteFillObject} width={width} height={height} pointerEvents="box-none">
    {walls.filter(w=>w?.a&&w?.b).map((w,i)=>{
      const active=!canvasFree&&!selectedElement&&i===selected;
      const dx=w.b.x-w.a.x,dy=w.b.y-w.a.y,L=Math.hypot(dx,dy)||1,ux=dx/L,uy=dy/L;
      let nx=-uy,ny=ux,mx=(w.a.x+w.b.x)/2,my=(w.a.y+w.b.y)/2;
      if((mx+nx*20-cx)**2+(my+ny*20-cy)**2 < (mx-nx*20-cx)**2+(my-ny*20-cy)**2){nx=-nx;ny=-ny}
      const off=active?28:24;
      const a={x:w.a.x+nx*off,y:w.a.y+ny*off},b={x:w.b.x+nx*off,y:w.b.y+ny*off},tx=(a.x+b.x)/2,ty=(a.y+b.y)/2;
      const insideX=mx-nx*17,insideY=my-ny*17, dim=active?BLUE:'#485968', ext='#9AA8B5';
      const rot=Math.atan2(dy,dx)*180/Math.PI;
      const wallLength=Number(w.length||room.lengths?.[i]||0);
      const relevant=(room.elements||[]).filter(e=>Number(e.wall)===Number(w.index));
      const cuts=[0,wallLength];
      relevant.forEach(e=>{const aw=alongWallWidth(e);cuts.push(clamp(e.left||0,0,wallLength));cuts.push(clamp((e.left||0)+aw,0,wallLength))});
      const vals=[...new Set(cuts.map(v=>Math.round(v*1000)/1000))].sort((aa,bb)=>aa-bb);
      const segOff=42, extensionStart=7;
      return <React.Fragment key={`tech-${i}`}>
        <Line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={active?BLUE:INK} strokeWidth={active?12:10} strokeLinecap="square"/>
        <Line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={WHITE} strokeWidth={active?6:5.2} strokeLinecap="square"/>
        <Line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="transparent" strokeWidth="40" onPress={onChooseWall?(()=>onChooseWall(i)):undefined}/>
        <Line x1={w.a.x} y1={w.a.y} x2={a.x} y2={a.y} stroke={ext} strokeWidth=".75"/>
        <Line x1={w.b.x} y1={w.b.y} x2={b.x} y2={b.y} stroke={ext} strokeWidth=".75"/>
        <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={dim} strokeWidth={active?1.5:1.05}/>
        <Line x1={a.x-ny*4} y1={a.y+nx*4} x2={a.x+ny*4} y2={a.y-nx*4} stroke={dim} strokeWidth="1.1"/>
        <Line x1={b.x-ny*4} y1={b.y+nx*4} x2={b.x+ny*4} y2={b.y-nx*4} stroke={dim} strokeWidth="1.1"/>
        <Rect x={tx-25} y={ty-8} width="50" height="16" rx="5" fill="#FFFFFF" stroke={active?'#B8D4FF':'#E2E8EE'} strokeWidth=".6"/>
        <SvgText x={tx} y={ty+3} fontSize="9.5" fontWeight="800" fill={dim} textAnchor="middle" transform={`rotate(${Math.abs(rot)>90?rot+180:rot} ${tx} ${ty})`} onPress={()=>{if(onChooseWall)onChooseWall(i);if(onEditWall)onEditWall(i)}}>{numFmt(w.length)} m</SvgText>
        <Rect x={insideX-22} y={insideY-7} width="44" height="14" rx="4" fill="rgba(255,255,255,.86)"/>
        <SvgText x={insideX} y={insideY+3} fontSize="7.8" fontWeight="800" fill={active?BLUE:'#657483'} textAnchor="middle">Parede {String.fromCharCode(65+i)}</SvgText>
        {wallLength>0&&relevant.length?vals.slice(0,-1).map((v,j)=>{
          const v2=vals[j+1],seg=v2-v;if(seg<.08)return null;
          const p1={x:w.a.x+ux*(v/wallLength)*L,y:w.a.y+uy*(v/wallLength)*L};
          const p2={x:w.a.x+ux*(v2/wallLength)*L,y:w.a.y+uy*(v2/wallLength)*L};
          const span=Math.hypot(p2.x-p1.x,p2.y-p1.y),compact=span<44,tier=compact?(j%2):0,localOff=segOff+tier*13;
          const sa={x:p1.x+nx*localOff,y:p1.y+ny*localOff},sb={x:p2.x+nx*localOff,y:p2.y+ny*localOff};
          const stx=(sa.x+sb.x)/2,sty=(sa.y+sb.y)/2,key=`plan-${i}-${j}`,focus=focusedCota===key,labelW=focus?54:(compact?34:32),labelH=focus?20:12,labelFont=focus?11.5:7.2;
          return <React.Fragment key={`seg-${i}-${j}`}>
            <Line x1={p1.x+nx*extensionStart} y1={p1.y+ny*extensionStart} x2={sa.x} y2={sa.y} stroke="#A6B3BE" strokeWidth=".65"/>
            <Line x1={p2.x+nx*extensionStart} y1={p2.y+ny*extensionStart} x2={sb.x} y2={sb.y} stroke="#A6B3BE" strokeWidth=".65"/>
            <Line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="#7F91A1" strokeWidth=".8"/>
            <Line x1={sa.x-ny*3} y1={sa.y+nx*3} x2={sa.x+ny*3} y2={sa.y-nx*3} stroke="#7F91A1" strokeWidth=".8"/>
            <Line x1={sb.x-ny*3} y1={sb.y+nx*3} x2={sb.x+ny*3} y2={sb.y-nx*3} stroke="#7F91A1" strokeWidth=".8"/>
            <Rect x={stx-labelW/2} y={sty-labelH/2} width={labelW} height={labelH} rx="5" fill={focus?'#EAF3FF':'#FFFFFF'} stroke={focus?BLUE:'transparent'} strokeWidth={focus?1:0} onPress={onFocusCota?(()=>onFocusCota(focus?null:key)):undefined}/>
            <SvgText x={stx} y={sty+(focus?4:2.5)} textAnchor="middle" fontSize={labelFont} fontWeight={focus?'900':'700'} fill={focus?BLUE:'#536473'} onPress={onFocusCota?(()=>onFocusCota(focus?null:key)):undefined}>{numFmt(seg)}</SvgText>
          </React.Fragment>;
        }):null}
      </React.Fragment>
    })}
  </Svg>;
}
function WallMeasureModal({ visible, title, initialWidth, initialHeight, onCancel, onSave }) {
  const [widthValue,setWidthValue]=useState(numFmt(initialWidth));
  const [heightValue,setHeightValue]=useState(numFmt(initialHeight));
  const [voiceListening,setVoiceListening]=useState(false),[voiceText,setVoiceText]=useState(''),[voiceMessage,setVoiceMessage]=useState('');
  const voiceSessionRef=useRef(false);
  const voiceOptions={lang:'pt-BR',interimResults:true,continuous:true,maxAlternatives:1,addsPunctuation:false};
  const isVoiceSaveCommand=t=>/(?:^|\s)(?:salvar|salva|confirmar|confirma|aplicar|aplica)(?:\s+(?:medidas?|medição))?[.! ]*$/i.test(String(t||'').trim());
  const stripVoiceSaveCommand=t=>String(t||'').replace(/(?:^|\s)(?:salvar|salva|confirmar|confirma|aplicar|aplica)(?:\s+(?:medidas?|medição))?[.! ]*$/i,'').trim();
  useEffect(()=>{setWidthValue(numFmt(initialWidth));setHeightValue(numFmt(initialHeight));if(visible){setVoiceText('');setVoiceMessage('');}},[visible,initialWidth,initialHeight]);
  useEffect(()=>()=>{voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}},[]);
  const applyWallVoice=t=>{
    const text=normalizeVoiceText(t);
    const values=extractVoiceMeasures(text);
    let changed=[];
    if(values.width!=null&&values.width>=.05&&values.width<=20){setWidthValue(numFmt(values.width));changed.push('largura');}
    if(values.height!=null&&values.height>=.05&&values.height<=10){setHeightValue(numFmt(values.height));changed.push('altura');}
    if(!changed.length){
      const raw=text.replace(/^(?:parede(?:\s+[a-d])?|comprimento|largura|medida)\s*/,'').trim();
      const v=spokenMeasureToMeters(raw)||spokenMeasureToMeters(text);
      if(v!=null&&v>=.05&&v<=20){setWidthValue(numFmt(v));changed.push('largura');}
    }
    setVoiceMessage(changed.length?`Preenchido: ${changed.join(', ')}.`:'Não encontrei as medidas. Tente: “largura 5 metros e 50, altura 2 metros e 65”.');
  };
  useSpeechRecognitionEvent('start',()=>{if(visible){setVoiceListening(true);setVoiceMessage('Ouvindo… fale as medidas e diga “salvar” ou “confirmar” quando terminar.');}});
  useSpeechRecognitionEvent('result',event=>{if(!visible)return;const t=(event.results||[]).map(r=>r?.transcript||'').filter(Boolean).join(' ').trim();if(!t)return;const command=event.isFinal&&isVoiceSaveCommand(t), spoken=stripVoiceSaveCommand(t);setVoiceText(prev=>event.isFinal?[prev,t].filter(Boolean).join(' · '):t);if(event.isFinal&&spoken)applyWallVoice(spoken);if(command){const values=extractVoiceMeasures(spoken);const nextW=values.width!=null?values.width:parseMeters(widthValue,initialWidth),nextH=values.height!=null?values.height:parseMeters(heightValue,initialHeight);voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}setVoiceListening(false);setVoiceMessage('Medidas confirmadas por voz. Salvando…');setTimeout(()=>onSave(clamp(nextW,.05,20),clamp(nextH,.05,10)),80);}});
  useSpeechRecognitionEvent('end',()=>{if(!visible)return;setVoiceListening(false);if(voiceSessionRef.current){setTimeout(()=>{if(voiceSessionRef.current&&visible){try{ExpoSpeechRecognitionModule.start(voiceOptions);}catch(_e){} }},180);}});
  useSpeechRecognitionEvent('error',event=>{if(!visible)return;if(event.error==='aborted')return;if(event.error==='no-speech'&&voiceSessionRef.current)return;voiceSessionRef.current=false;setVoiceListening(false);setVoiceMessage('Não consegui ouvir. Toque em Falar e tente novamente.');});
  const toggleVoice=async()=>{try{if(voiceSessionRef.current||voiceListening){voiceSessionRef.current=false;ExpoSpeechRecognitionModule.stop();setVoiceListening(false);setVoiceMessage('Ditado concluído. Confira largura e altura antes de aplicar.');return;}const permission=await ExpoSpeechRecognitionModule.requestPermissionsAsync();if(!permission.granted){Alert.alert('Microfone','Autorize o microfone para ditar as medidas.');return;}setVoiceText('');setVoiceMessage('');voiceSessionRef.current=true;ExpoSpeechRecognitionModule.start(voiceOptions);}catch(e){voiceSessionRef.current=false;console.warn('voice wall',e);Alert.alert('Voz','Não foi possível iniciar o reconhecimento de voz.');}};
  const apply=()=>{voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}onSave(clamp(parseMeters(widthValue,initialWidth),.05,20),clamp(parseMeters(heightValue,initialHeight),.05,10));};
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}><KeyboardAvoidingView style={styles.sheetBackdrop} behavior={Platform.OS==='ios'?'padding':undefined}><Pressable style={{flex:1}} onPress={onCancel}/><View style={[styles.sheet,styles.techEditSheet]}><View style={styles.sheetHandle}/><View style={styles.techEditHead}><View style={styles.wallEditIcon}><Text style={styles.wallEditIconText}>↔</Text></View><View style={{flex:1}}><Text style={styles.techEditEyebrow}>EDIÇÃO TÉCNICA</Text><Text style={styles.techEditTitle}>{title}</Text><Text style={styles.formHint}>Largura e altura reais da parede</Text></View></View><View style={styles.techInfoStrip}><Text style={styles.techInfoTitle}>Medidas em metros</Text><Text style={styles.techInfoText}>Digite ou fale a largura e a altura da parede. Você pode conferir antes de aplicar.</Text></View><View style={styles.voiceMeasureCard}><View style={{flex:1}}><Text style={styles.voiceMeasureTitle}>Preencher por voz</Text><Text style={styles.voiceMeasureHint}>{voiceListening?'Pode continuar falando… ao terminar diga “salvar” ou “confirmar”.':'Ex.: “largura 5 metros e 50, altura 2 metros e 65, salvar”'}</Text>{voiceText?<Text style={styles.voiceTranscript}>“{voiceText}”</Text>:null}{voiceMessage?<Text style={styles.voiceMessage}>{voiceMessage}</Text>:null}</View><Pressable onPress={toggleVoice} style={[styles.voiceMicBtn,voiceListening&&styles.voiceMicBtnOn]}><Text style={styles.voiceMicIcon}>{voiceListening?'■':'🎙️'}</Text><Text style={[styles.voiceMicText,voiceListening&&{color:WHITE}]}>{voiceListening?'Parar':'Falar'}</Text></Pressable></View><Text style={styles.formSection}>Dimensões</Text><View style={styles.twoCols}><MiniField label="Largura" value={widthValue} onChange={setWidthValue}/><MiniField label="Altura" value={heightValue} onChange={setHeightValue}/></View><View style={{flexDirection:'row',gap:10,marginTop:16}}><Button secondary title="Cancelar" onPress={()=>{voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}onCancel();}}/><Button title="Aplicar" onPress={apply}/></View></View></KeyboardAvoidingView></Modal>;
}

function ItemIcon({ type, size=30 }) { return <View style={[styles.itemIcon,{width:size,height:size,borderRadius:size*.28}]}><Text style={{fontSize:size*.48}}>{ICONS[type]||'•'}</Text></View>; }

function AddSheet({ visible, onClose, onAdd, wallIndex, initialGroup='Aberturas', allowedGroups=null, excludedItems=[] }) {
  const available=GROUPS.filter(g=>!allowedGroups||allowedGroups.includes(g.key));
  const [group,setGroup]=useState(initialGroup);
  useEffect(()=>{ if(visible){ const next=available.some(g=>g.key===initialGroup)?initialGroup:(available[0]?.key||'Aberturas'); setGroup(next); } },[visible,initialGroup,allowedGroups?.join('|')]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.sheetBackdrop}><Pressable style={{flex:1}} onPress={onClose}/><View style={styles.sheet}><View style={styles.sheetHandle}/><Text style={styles.modalTitle}>Adicionar {wallIndex!=null?`na Parede ${String.fromCharCode(65+wallIndex)}`:''}</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8,paddingVertical:12}}>{available.map(g=><Pressable key={g.key} onPress={()=>setGroup(g.key)} style={[styles.groupTab,group===g.key&&styles.groupTabOn]}><Text style={[styles.groupTabText,group===g.key&&styles.groupTabTextOn]}>{g.key}</Text></Pressable>)}</ScrollView><ScrollView style={{maxHeight:360}} contentContainerStyle={styles.iconGrid} showsVerticalScrollIndicator={true}>{available.find(g=>g.key===group)?.items.filter(t=>!excludedItems.includes(t)).map(t=><Pressable key={t} onPress={()=>onAdd(t)} style={styles.iconChoice}><ItemIcon type={t} size={42}/><Text style={styles.iconChoiceText}>{t}</Text></Pressable>)}</ScrollView></View></View></Modal>;
}

function PlanSymbol({type, selected=false, width=58, swing='left', inward=1}){
  const c=selected?BLUE:TECH.wall, soft=selected?BLUE:TECH.dim;
  const W=Math.max(48,width), wallY=13, gap=8;
  if(type==='Porta'){
    const H=76, wy=H/2, span=Math.min(W-gap*2,31), dir=inward>=0?1:-1;
    const hingeX=swing==='right'?W-gap:gap, closedX=swing==='right'?gap:W-gap;
    const openX=hingeX, openY=wy+dir*span;
    const sweep=((swing==='right')===(dir>0))?0:1;
    const arc=`M ${closedX} ${wy} A ${span} ${span} 0 0 ${sweep} ${openX} ${openY}`;
    const labelY=dir>0?H-4:8;
    return <View style={{width:W,height:H,alignItems:'center'}}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <Line x1="1" y1={wy} x2={gap} y2={wy} stroke={TECH.wall} strokeWidth="7"/>
        <Line x1={W-gap} y1={wy} x2={W-1} y2={wy} stroke={TECH.wall} strokeWidth="7"/>
        <Line x1={hingeX} y1={wy} x2={openX} y2={openY} stroke={c} strokeWidth="1.8"/>
        <Path d={arc} fill="none" stroke={soft} strokeWidth="1.25" strokeDasharray="3 2"/>
        <Circle cx={hingeX} cy={wy} r="1.6" fill={c}/>
        <SvgText x={W/2} y={labelY} textAnchor="middle" fontSize="6.8" fontWeight="700" fill={TECH.dim}>PORTA</SvgText>
      </Svg>
    </View>;
  }
  if(type==='Janela') return <View style={{width:W,height:34,alignItems:'center'}}>
    <Svg width={W} height={34} viewBox={`0 0 ${W} 34`}>
      <Line x1="1" y1="13" x2={W-1} y2="13" stroke={TECH.wall} strokeWidth="7"/>
      <Rect x="7" y="7.5" width={Math.max(10,W-14)} height="11" fill={WHITE} stroke={c} strokeWidth="1.3"/>
      <Line x1="7" y1="13" x2={W-7} y2="13" stroke={soft} strokeWidth="1"/>
      <Line x1={W/2} y1="7.5" x2={W/2} y2="18.5" stroke={soft} strokeWidth=".9"/>
      <SvgText x={W/2} y="31" textAnchor="middle" fontSize="6.8" fontWeight="700" fill={TECH.dim}>JANELA</SvgText>
    </Svg>
  </View>;
  if(type==='Passagem') return <View style={{width:W,height:30}}><Svg width={W} height={30}>
    <Rect x="1" y="6" width={Math.max(10,W-2)} height="14" rx="1.5" fill="#101820" stroke={selected?BLUE:'#101820'} strokeWidth={selected?2:1}/>
    <SvgText x={W/2} y="15.7" textAnchor="middle" fontSize="2.2" fontWeight="700" fill="#FFFFFF">PASSAGEM</SvgText>
  </Svg></View>;
  return <View style={[styles.planWordSymbol,selected&&styles.planWordSymbolSelected,{width:Math.max(W,58),backgroundColor:isStructure(type)?TECH.structure:WHITE},isReservedSpace(type)&&{backgroundColor:'rgba(255,255,255,.72)',borderStyle:'dashed',borderColor:selected?BLUE:'#66758A'}]}><Text style={[styles.planWordText,isReservedSpace(type)&&{fontSize:7}]}>{type.toUpperCase()}</Text></View>;
}
function PlanElement({element, wall, wallLength, wallCount=4, zoom, selected, onSelect, onChange, pinchingRef}) {
  const dx=wall.b.x-wall.a.x, dy=wall.b.y-wall.a.y, pixLen=Math.max(1,Math.hypot(dx,dy));
  const ux=dx/pixLen, uy=dy/pixLen, nx=-uy, ny=ux, ppm=pixLen/Math.max(.1,wallLength);
  const isColumnPillar=element.type==='Coluna'||element.type==='Pilar';
  const wallHalfPx=6;
  // Para Coluna/Pilar, o centro ao longo da parede também respeita a face interna
  // das paredes perpendiculares nos cantos. Assim o bloco nunca invade as 4 linhas.
  const halfAlongM=Math.max(.001,Number(element.width||.20))/2;
  const cornerClearanceM=isColumnPillar?wallHalfPx/ppm:0;
  const minCenter=halfAlongM+cornerClearanceM;
  const maxCenter=Math.max(minCenter,wallLength-halfAlongM-cornerClearanceM);
  const centerAlongM=isColumnPillar
    ?clamp(Number(element.left||0)+halfAlongM,minCenter,maxCenter)
    :(Number(element.left||0)+Number(element.width||0)/2);
  const t=clamp(centerAlongM/Math.max(.1,wallLength),0,1);
  const x=wall.a.x+dx*t, y=wall.a.y+dy*t; const start=useRef(element.left);
  const pan=Gesture.Pan().minDistance(7).activateAfterLongPress(70).maxPointers(1).runOnJS(true).onBegin(()=>{start.current=element.left;}).onUpdate(e=>{
    if(pinchingRef?.current)return;
    const deltaPx=(e.translationX*ux+e.translationY*uy)/Math.max(.8,zoom);
    const left=clamp(start.current+deltaPx/ppm,0,Math.max(0,wallLength-element.width)); onChange({...element,left});
  });
  const tap=Gesture.Tap().maxDistance(8).runOnJS(true).onEnd((_e,ok)=>{if(ok)onSelect()});
  const objectGesture=selected?Gesture.Exclusive(pan,tap):tap;
  const angle=Math.atan2(dy,dx)*180/Math.PI;
  const visualW=clamp(element.width*ppm,48,92);
  const inwardVec=planInteriorVector(wallCount,element.wall??0), inwardSign=(nx*inwardVec[0]+ny*inwardVec[1])>=0?1:-1;
  // Estruturas na planta pertencem ao lado INTERNO da parede. O centro do
  // símbolo fica meia profundidade para dentro + meia espessura gráfica da parede.
  // Coluna/Pilar usam a escala REAL da planta: largura x profundidade em metros
  // multiplicadas pelo mesmo ppm da parede. Sem limite artificial de tamanho.
  const exactDepthPx=Math.max(2,Number(element.depth||element.width||.20)*ppm);
  const exactAlongPx=Math.max(2,Number(element.width||.20)*ppm);
  const structureDepthPx=isStructure(element.type)?(isColumnPillar?exactDepthPx:clamp(exactDepthPx,14,46)):0;
  const structureAlongPx=isStructure(element.type)?(isColumnPillar?exactAlongPx:clamp(exactAlongPx,14,46)):visualW;
  // O bloco começa exatamente depois da face interna da parede (6 px do eixo)
  // e cresce 100% para dentro do cômodo.
  const structureInset=isStructure(element.type)?(wallHalfPx+structureDepthPx/2):0;
  const drawX=x+inwardVec[0]*structureInset, drawY=y+inwardVec[1]*structureInset;
  const boxH=isStructure(element.type)?structureDepthPx:(element.type==='Porta'?76:62);
  if(isStructure(element.type)){
    const stroke=selected?BLUE:'#65727D', fill=selected?'rgba(22,119,242,.18)':'rgba(205,214,221,.96)';
    return <GestureDetector gesture={objectGesture}><View style={[styles.planObjTouch,{left:drawX-structureAlongPx/2,top:drawY-structureDepthPx/2,width:structureAlongPx,height:structureDepthPx,zIndex:visualLayer(element),transform:[{rotate:`${angle}deg`}]}]}>
      <Svg width={structureAlongPx} height={structureDepthPx} viewBox={`0 0 ${structureAlongPx} ${structureDepthPx}`}>
        <Rect x="1" y="1" width={Math.max(1,structureAlongPx-2)} height={Math.max(1,structureDepthPx-2)} rx="2" fill={fill} stroke={stroke} strokeWidth={selected?2:1.2}/>
      </Svg>
    </View></GestureDetector>;
  }
  if(element.type==='Passagem'){
    const passageW=Math.max(34,element.width*ppm), passageH=14;
    return <GestureDetector gesture={objectGesture}><View style={[styles.planObjTouch,{left:x-passageW/2,top:y-passageH/2,width:passageW,height:passageH,zIndex:visualLayer(element),transform:[{rotate:`${angle}deg`}]}]}>
      <Svg width={passageW} height={passageH} viewBox={`0 0 ${passageW} ${passageH}`}>
        <Rect x="0" y="0" width={passageW} height={passageH} rx="1.5" fill="#101820" stroke={selected?BLUE:'#101820'} strokeWidth={selected?2:1}/>
        <SvgText x={passageW/2} y="9.5" textAnchor="middle" fontSize="2.2" fontWeight="700" fill="#FFFFFF">PASSAGEM</SvgText>
      </Svg>
    </View></GestureDetector>;
  }
  return <GestureDetector gesture={objectGesture}><View style={[styles.planObjTouch,{left:drawX-50,top:drawY-boxH/2,width:100,height:boxH,zIndex:visualLayer(element),transform:[{rotate:`${angle}deg`}]}]}><PlanSymbol type={element.type} selected={selected} angle={angle} width={visualW} swing={element.swing||'left'} inward={inwardSign}/></View></GestureDetector>;
}


function planInteriorVector(count,index){
  const maps={
    1:[[0,1]],
    2:[[0,1],[-1,0]],
    3:[[0,1],[-1,0],[1,0]],
    4:[[0,1],[-1,0],[0,-1],[1,0]],
  };
  return (maps[count]||maps[4])[index]||[0,1];
}

function PlanEquipmentElement({element, wall, wallLength, wallCount, zoom, selected, onSelect, onChange, pinchingRef, canvasW, canvasH, planPpm}){
  const internal=isInternalWall(element.type);
  const free=!internal&&(isFreePlanType(element.type)||element.free===true);
  const dx=wall?.b?.x-wall?.a?.x||1,dy=wall?.b?.y-wall?.a?.y||0,pixLen=Math.max(1,Math.hypot(dx,dy));
  const ux=dx/pixLen,uy=dy/pixLen,nx=-uy,ny=ux;
  const ppm=free?Math.max(20,planPpm||70):pixLen/Math.max(.1,wallLength);
  const inward=planInteriorVector(wallCount,element.wall),sign=(nx*inward[0]+ny*inward[1])>=0?1:-1;
  const internalThick=internal?internalWallThickness(element):0;
  const internalThickPx=internal?10:0;
  const internalLenM=internal?(element.type==='Parede vertical'?Number(element.depth||1.50):Number(element.width||1.50)):0;
  const internalLenPx=internal?clamp(internalLenM*ppm,24,220):0;
  const depthPx=internal?internalThickPx:clamp((element.depth||.55)*ppm,18,72);
  const visualW=internal?internalLenPx:clamp(element.width*ppm,28,140);
  const anchorSize=internal?internalThick:Number(element.width||0);
  const t=clamp((Number(element.left||0)+anchorSize/2)/Math.max(.1,wallLength),0,1);
  const anchorX=(wall?.a?.x||0)+dx*t,anchorY=(wall?.a?.y||0)+dy*t;
  const anchoredX=internal?anchorX+nx*sign*internalLenPx/2:anchorX+nx*sign*depthPx/2;
  const anchoredY=internal?anchorY+ny*sign*internalLenPx/2:anchorY+ny*sign*depthPx/2;
  const freeX=clamp(Number.isFinite(element.freeX)?element.freeX:.50,.05,.95),freeY=clamp(Number.isFinite(element.freeY)?element.freeY:.58,.08,.92);
  const x=free?freeX*(canvasW||1):anchoredX,y=free?freeY*(canvasH||1):anchoredY;
  const baseAngle=Math.atan2(dy,dx)*180/Math.PI;
  const angle=free?0:(internal?baseAngle+90:baseAngle),start=useRef(element.left),freeStart=useRef({x:freeX,y:freeY});
  const pan=Gesture.Pan().minDistance(7).activateAfterLongPress(70).maxPointers(1).runOnJS(true).onBegin(()=>{
    start.current=Number(element.left||0);freeStart.current={x:freeX,y:freeY};
  }).onUpdate(e=>{
    if(pinchingRef?.current)return;
    if(free){
      const nxp=clamp(freeStart.current.x+(e.translationX/Math.max(.8,zoom))/Math.max(1,canvasW),.05,.95);
      const nyp=clamp(freeStart.current.y+(e.translationY/Math.max(.8,zoom))/Math.max(1,canvasH),.08,.92);
      onChange({...element,free:true,freeX:nxp,freeY:nyp});
      return;
    }
    const deltaPx=(e.translationX*ux+e.translationY*uy)/Math.max(.8,zoom);
    const occupied=internal?internalThick:Number(element.width||0);
    const left=clamp(start.current+deltaPx/ppm,0,Math.max(0,wallLength-occupied));
    onChange({...element,free:internal?false:element.free,left,wall:element.wall});
  });
  const tap=Gesture.Tap().maxDistance(8).runOnJS(true).onEnd((_e,ok)=>{if(ok)onSelect()});
  const objectGesture=selected?Gesture.Exclusive(pan,tap):tap;
  const stroke=selected?BLUE:'#5C6872',fill=selected?'rgba(22,119,242,.12)':'rgba(88,104,116,.07)';
  const icon=()=>{
    if(internal)return <><Rect x="0" y="0" width={visualW} height={depthPx} fill={selected?BLUE:INK}/><Rect x="0" y={Math.max(1,(depthPx-5.2)/2)} width={visualW} height={Math.max(1,Math.min(5.2,depthPx-2))} fill={WHITE}/></>;
    if(isReservedSpace(element.type))return <><Rect x="3" y="3" width={Math.max(2,visualW-6)} height={Math.max(2,depthPx-6)} rx="2" fill="rgba(255,255,255,.18)" stroke={stroke} strokeWidth={selected?1.8:1.2} strokeDasharray="5 3"/><Line x1="7" y1={depthPx/2} x2={Math.max(7,visualW-7)} y2={depthPx/2} stroke="#8A98A3" strokeWidth=".6" strokeDasharray="3 3"/></>;
    if(element.type==='Pia'||element.type==='Tanque')return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="2" fill="rgba(238,244,247,.82)" stroke={stroke} strokeWidth="1"/><Rect x={visualW*.30} y={depthPx*.24} width={visualW*.40} height={depthPx*.52} rx="3" fill="rgba(188,207,216,.55)" stroke="#6E8089" strokeWidth=".8"/><Path d={`M ${visualW*.50} ${depthPx*.24} q 0 ${-depthPx*.18} ${visualW*.12} ${-depthPx*.18}`} fill="none" stroke="#596A73" strokeWidth="1.1"/></>;
    if(element.type==='Fogão'||element.type==='Cooktop')return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="2" fill="rgba(58,66,72,.12)" stroke={stroke} strokeWidth="1"/>{[[.28,.33],[.72,.33],[.28,.68],[.72,.68]].map((p,i)=><Circle key={i} cx={visualW*p[0]} cy={depthPx*p[1]} r={Math.max(2,Math.min(5,depthPx*.12))} fill="none" stroke="#46525A" strokeWidth="1"/>)}</>;
    if(element.type==='Geladeira')return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="2" fill="rgba(230,235,238,.62)" stroke={stroke} strokeWidth="1"/><Line x1={visualW*.48} y1="3" x2={visualW*.48} y2={depthPx-3} stroke="#82909A" strokeWidth=".8"/><Line x1={visualW*.52} y1={depthPx*.20} x2={visualW*.52} y2={depthPx*.80} stroke="#82909A" strokeWidth="1"/></>;
    if(element.type==='Máquina de lavar'||element.type==='Lava-louças')return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="2" fill="rgba(231,236,239,.58)" stroke={stroke} strokeWidth="1"/><Circle cx={visualW/2} cy={depthPx/2} r={Math.max(4,depthPx*.26)} fill="rgba(167,196,208,.30)" stroke="#6F7E87" strokeWidth=".8"/></>;
    if(element.type==='Cama solteiro'||element.type==='Cama casal'||element.type==='Beliche')return <><Rect x="2" y="2" width={visualW-4} height={depthPx-4} rx="3" fill="rgba(231,226,216,.48)" stroke={stroke} strokeWidth="1"/><Rect x={visualW*.10} y={depthPx*.08} width={visualW*.32} height={Math.max(5,depthPx*.20)} rx="2" fill="#F7F4EE" stroke="#8A8176" strokeWidth=".7"/><Line x1={visualW*.08} y1={depthPx*.34} x2={visualW*.92} y2={depthPx*.34} stroke="#A39A8F" strokeWidth=".7"/>{element.type==='Beliche'?<Line x1={visualW*.50} y1="3" x2={visualW*.50} y2={depthPx-3} stroke="#7F756B" strokeWidth="1"/>:null}</>;
    if(element.type==='Mesa')return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="4" fill="rgba(205,184,156,.22)" stroke={stroke} strokeWidth="1"/>{[[8,8],[visualW-8,8],[8,depthPx-8],[visualW-8,depthPx-8]].map((p,i)=><Circle key={i} cx={p[0]} cy={p[1]} r="2.2" fill="#776B5E"/>)}</>;
    if(element.type==='Sofá')return <><Rect x="3" y="5" width={visualW-6} height={depthPx-8} rx="6" fill="rgba(196,181,162,.25)" stroke={stroke} strokeWidth="1"/><Line x1="8" y1={depthPx*.28} x2={visualW-8} y2={depthPx*.28} stroke="#8E7D69" strokeWidth="1"/><Line x1={visualW*.5} y1={depthPx*.28} x2={visualW*.5} y2={depthPx-6} stroke="#A3917D" strokeWidth=".8"/></>;
    if(element.type==='Televisão')return <><Rect x="3" y={Math.max(3,depthPx*.25)} width={visualW-6} height={Math.max(7,depthPx*.50)} rx="2" fill="rgba(73,87,97,.14)" stroke={stroke} strokeWidth="1"/><Line x1={visualW*.50} y1={depthPx*.75} x2={visualW*.50} y2={depthPx*.92} stroke="#64717B" strokeWidth="1"/></>;
    return <><Rect x="3" y="3" width={visualW-6} height={depthPx-6} rx="2" fill={fill} stroke={stroke} strokeWidth="1"/><Line x1="7" y1={depthPx/2} x2={visualW-7} y2={depthPx/2} stroke="#87949D" strokeWidth=".6"/></>;
  };
  return <GestureDetector gesture={objectGesture}><View style={{position:'absolute',left:x-visualW/2,top:y-depthPx/2,width:visualW,height:depthPx,transform:[{rotate:`${angle}deg`}],borderRadius:3,zIndex:visualLayer(element)}}><Svg width={visualW} height={depthPx}>{icon()}</Svg>{selected?<View style={{position:'absolute',left:3,right:3,bottom:2,alignItems:'center'}}><Text style={{fontSize:6.2,fontWeight:'900',color:BLUE,backgroundColor:'rgba(255,255,255,.82)',paddingHorizontal:3,borderRadius:3}}>{element.type} · {numFmt(element.width)}</Text></View>:null}</View></GestureDetector>;
}

function TechnicalElevationBase({wallW,wallH,px,width,height,objects=[],focusedCota=null,onFocusCota}) {
  const x=27,y=46,ww=wallW*px,hh=wallH*px,dim='#284B70',ext='#A7B4C0',baseY=y+hh;
  const tick=(x1,y1,x2,y2,key)=><Line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={dim} strokeWidth="1"/>;
  return <Svg width={width} height={height} style={StyleSheet.absoluteFillObject} pointerEvents="none">
    <Defs>
      <LinearGradient id="elevWallPro" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FFFDF8"/><Stop offset="1" stopColor="#F2EEE7"/></LinearGradient>
      <LinearGradient id="elevFloorPro" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#E8E0D5"/><Stop offset="1" stopColor="#C9BBA8"/></LinearGradient>
    </Defs>
    <Rect width={width} height={height} fill="#EEF2F5"/>
    <Rect x={x+6} y={y+7} width={ww} height={hh} rx="2" fill="#26323A" opacity=".10"/>
    <Rect x={x} y={y} width={ww} height={hh} fill="url(#elevWallPro)" stroke="#313A42" strokeWidth="2.2"/>
    <Rect x={x} y={baseY-1} width={ww} height={Math.max(16,height-baseY+1)} fill="url(#elevFloorPro)"/>
    {[.2,.4,.6,.8].map(t=><Line key={`tile-${t}`} x1={x+ww*t} y1={baseY} x2={x+ww*t-5} y2={height} stroke="#B7AA99" strokeWidth=".55" opacity=".55"/>)}
    <Line x1={x} y1={y-19} x2={x+ww} y2={y-19} stroke={dim} strokeWidth="1.05"/>
    <Line x1={x} y1={y-24} x2={x} y2={y-10} stroke={ext} strokeWidth=".8"/><Line x1={x+ww} y1={y-24} x2={x+ww} y2={y-10} stroke={ext} strokeWidth=".8"/>
    {tick(x-3,y-22,x+3,y-16,'ta')}{tick(x+ww-3,y-22,x+ww+3,y-16,'tb')}
    <Rect x={x+ww/2-27} y={y-28} width="54" height="16" rx="5" fill="#FFFFFF" stroke="#D9E3EC" strokeWidth=".6"/>
    <SvgText x={x+ww/2} y={y-17} textAnchor="middle" fontSize="9.5" fontWeight="800" fill={dim}>{numFmt(wallW)} m</SvgText>
    <Line x1={x+ww+17} y1={y} x2={x+ww+17} y2={baseY} stroke={dim} strokeWidth="1.05"/>
    <Line x1={x+ww+10} y1={y} x2={x+ww+23} y2={y} stroke={ext} strokeWidth=".8"/><Line x1={x+ww+10} y1={baseY} x2={x+ww+23} y2={baseY} stroke={ext} strokeWidth=".8"/>
    {tick(x+ww+14,y-3,x+ww+20,y+3,'tc')}{tick(x+ww+14,baseY-3,x+ww+20,baseY+3,'td')}
    <Rect x={x+ww+20} y={y+hh/2-27} width="17" height="54" rx="5" fill="#FFFFFF" stroke="#D9E3EC" strokeWidth=".6"/>
    <SvgText x={x+ww+29} y={y+hh/2+3} fontSize="9.5" fontWeight="800" fill={dim} textAnchor="middle" transform={`rotate(90 ${x+ww+29} ${y+hh/2})`}>{numFmt(wallH)} m</SvgText>
    <Line x1={x-9} y1={baseY} x2={x+ww+8} y2={baseY} stroke="#374047" strokeWidth="1.7"/>
    {(()=>{
      if(!objects?.length)return null;
      const cuts=[0,wallW];
      objects.filter(e=>isOpening(e.type)||isEquipment(e.type)||isStructure(e.type)||isReservedSpace(e.type)).forEach(e=>{
        cuts.push(clamp(e.left||0,0,wallW));
        cuts.push(clamp((e.left||0)+(e.width||0),0,wallW));
      });
      const vals=[...new Set(cuts.map(v=>Math.round(v*1000)/1000))].sort((a,b)=>a-b);
      const wallTop=y;
      return vals.slice(0,-1).map((v,i)=>{
        const b=vals[i+1],seg=b-v;if(seg<.08)return null;
        const x1=x+v*px,x2=x+b*px,c=(x1+x2)/2,span=Math.abs(x2-x1);
        const compact=span<44, tier=compact?(i%2):0, sy=14-tier*13;
        const key=`front-${i}`,focus=focusedCota===key,labelW=focus?54:(compact?34:30),labelH=focus?20:12,labelFont=focus?11.5:6.8;
        return <React.Fragment key={`fdu-${i}`}>
          <Line x1={x1} y1={wallTop} x2={x1} y2={sy} stroke="#A6B3BE" strokeWidth=".65"/>
          <Line x1={x2} y1={wallTop} x2={x2} y2={sy} stroke="#A6B3BE" strokeWidth=".65"/>
          <Line x1={x1} y1={sy} x2={x2} y2={sy} stroke="#718496" strokeWidth=".8"/>
          <Line x1={x1} y1={sy-4} x2={x1} y2={sy+4} stroke="#718496" strokeWidth=".8"/>
          <Line x1={x2} y1={sy-4} x2={x2} y2={sy+4} stroke="#718496" strokeWidth=".8"/>
          <Rect x={c-labelW/2} y={sy-labelH/2} width={labelW} height={labelH} rx="5" fill={focus?'#EAF3FF':'#FFFFFF'} stroke={focus?BLUE:'transparent'} strokeWidth={focus?1:0} onPress={onFocusCota?(()=>onFocusCota(focus?null:key)):undefined}/>
          <SvgText x={c} y={sy+(focus?4:2.5)} textAnchor="middle" fontSize={labelFont} fontWeight={focus?'900':'700'} fill={focus?BLUE:'#4A5A68'} onPress={onFocusCota?(()=>onFocusCota(focus?null:key)):undefined}>{numFmt(seg)}</SvgText>
        </React.Fragment>;
      });
    })()}
  </Svg>;
}


function PerspectiveCanvas({room, selectedWall=0, selectedElement=null, wallHighlight=true, width, height, onSelectWall, onSelectElement, onFree}) {
  const count=room.wallCount||1,H=room.height||2.65,elems=(room.elements||[]);
  const qpath=q=>`M ${q[0][0]} ${q[0][1]} L ${q[1][0]} ${q[1][1]} L ${q[2][0]} ${q[2][1]} L ${q[3][0]} ${q[3][1]} Z`;
  const quad=(a,b,c,d)=>`M ${a[0]} ${a[1]} L ${b[0]} ${b[1]} L ${c[0]} ${c[1]} L ${d[0]} ${d[1]} Z`;
  const point=(q,u,v)=>{const t=[q[0][0]+(q[1][0]-q[0][0])*u,q[0][1]+(q[1][1]-q[0][1])*u],bt=[q[3][0]+(q[2][0]-q[3][0])*u,q[3][1]+(q[2][1]-q[3][1])*u];return [t[0]+(bt[0]-t[0])*v,t[1]+(bt[1]-t[1])*v]};
  const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  const stop=(fn)=>(ev)=>{ev?.stopPropagation?.();fn?.()};
  const pal=type=>{
    if(type==='Porta')return {f:'#C69A68',s:'#8E6845',t:'#E0BE95',l:'#60452F'};
    if(type==='Janela')return {f:'#D4EEF7',s:'#86A8B5',t:'#F2FBFD',l:'#536F79'};
    if(type==='Pia'||type==='Tanque')return {f:'#CFD5D8',s:'#929CA1',t:'#F2F4F4',l:'#59656B'};
    if(type==='Geladeira')return {f:'#EDF0F2',s:'#AEB8BE',t:'#FFFFFF',l:'#59656C'};
    if(type==='Fogão'||type==='Cooktop'||type==='Forno'||type==='Micro-ondas')return {f:'#596167',s:'#2E353A',t:'#7A8389',l:'#20262A'};
    if(type==='Máquina de lavar'||type==='Lava-louças')return {f:'#EDF0F2',s:'#AAB4BA',t:'#FFFFFF',l:'#5E6970'};
    if(type==='Cama solteiro'||type==='Cama casal'||type==='Beliche')return {f:'#E8E2D8',s:'#B7AA98',t:'#FAF7F1',l:'#776B5E'};
    if(type==='Mesa')return {f:'#CDB99F',s:'#9A8267',t:'#E7D9C6',l:'#6E5A46'};
    if(type==='Televisão')return {f:'#303940',s:'#151B20',t:'#58656F',l:'#101820'};
    if(isStructure(type))return {f:'#CBD1D4',s:'#9CA5AA',t:'#E4E8EA',l:'#606A70'};
    return {f:'#E9ECEE',s:'#B6BFC4',t:'#F8FAFA',l:'#67727A'};
  };
  const depthVec=(role,e)=>{const k=clamp((e.depth??.18)/.7,.02,1);return role==='left'?[22*k,12*k]:role==='right'?[-22*k,12*k]:[0,20*k]};
  const pointMark=(e,m,active)=>{
    const stroke=active?BLUE:'#49545C',fill='#FBFCFD';
    if(e.type==='Tomada')return <React.Fragment key={e.id}><Rect x={m[0]-7} y={m[1]-6} width="14" height="12" rx="2.5" fill={fill} stroke={stroke} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Circle cx={m[0]-2.4} cy={m[1]-1} r="1.2" fill={stroke}/><Circle cx={m[0]+2.4} cy={m[1]-1} r="1.2" fill={stroke}/><Path d={`M ${m[0]} ${m[1]+1} l -2 3 h 4 Z`} fill={stroke}/></React.Fragment>;
    if(e.type==='Interruptor')return <React.Fragment key={e.id}><Rect x={m[0]-6} y={m[1]-8} width="12" height="16" rx="2" fill={fill} stroke={stroke} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Rect x={m[0]-3} y={m[1]-5} width="6" height="10" rx="1" fill="#E8EDF0" stroke={stroke} strokeWidth=".7"/></React.Fragment>;
    if(e.type==='Água')return <React.Fragment key={e.id}><Circle cx={m[0]} cy={m[1]} r="6" fill="#E9F6FC" stroke={active?BLUE:'#39738C'} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Circle cx={m[0]} cy={m[1]} r="2.2" fill="#78C7E8"/></React.Fragment>;
    if(e.type==='Esgoto')return <React.Fragment key={e.id}><Circle cx={m[0]} cy={m[1]} r="6" fill={fill} stroke={stroke} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Circle cx={m[0]} cy={m[1]} r="3" fill="none" stroke="#75818A" strokeWidth="1"/></React.Fragment>;
    if(e.type==='Gás')return <React.Fragment key={e.id}><Circle cx={m[0]} cy={m[1]} r="6" fill="#FFF8E7" stroke={active?BLUE:'#75602D'} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Path d={`M ${m[0]} ${m[1]-4} C ${m[0]+4} ${m[1]} ${m[0]+2} ${m[1]+4} ${m[0]} ${m[1]+4} C ${m[0]-3} ${m[1]+4} ${m[0]-4} ${m[1]+1} ${m[0]} ${m[1]-4} Z`} fill="#E6C15D"/></React.Fragment>;
    return <React.Fragment key={e.id}><Rect x={m[0]-6} y={m[1]-6} width="12" height="12" rx="2" fill={fill} stroke={stroke} strokeWidth={active?1.8:1.1} onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/><Rect x={m[0]-3} y={m[1]-2} width="6" height="4" fill="#DDE6EB" stroke={stroke} strokeWidth=".7"/></React.Fragment>;
  };
  const renderObj=(e,q,wallIndex,role)=>{
    const ww=room.lengths[wallIndex]||3.2,u1=clamp(e.left/ww,0,1),u2=clamp((e.left+e.width)/ww,0,1),v1=clamp(1-(e.bottom+e.height)/H,0,1),v2=clamp(1-e.bottom/H,0,1);
    const a=point(q,u1,v1),b=point(q,u2,v1),c=point(q,u2,v2),d=point(q,u1,v2),m=point(q,(u1+u2)/2,(v1+v2)/2),active=e.id===selectedElement,P=pal(e.type);
    if(isPoint(e.type))return pointMark(e,m,active);
    if(isOpening(e.type)){
      const hit=<Path d={quad(a,b,c,d)} fill="transparent" stroke="transparent" strokeWidth="8" onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/>;
      if(e.type==='Janela'){const iv=[point(q,u1+.025,v1+.04),point(q,u2-.025,v1+.04),point(q,u2-.025,v2-.04),point(q,u1+.025,v2-.04)],vm1=point(q,(u1+u2)/2,v1+.04),vm2=point(q,(u1+u2)/2,v2-.04);return <React.Fragment key={e.id}><Path d={quad(a,b,c,d)} fill="#DCEFF6" stroke={active?BLUE:P.l} strokeWidth={active?2.2:1.3}/><Path d={qpath(iv)} fill="#BFE4F1" stroke="#6F8D98" strokeWidth=".8"/><Line x1={vm1[0]} y1={vm1[1]} x2={vm2[0]} y2={vm2[1]} stroke="#6F8D98" strokeWidth=".8"/><Line x1={d[0]} y1={d[1]} x2={c[0]} y2={c[1]} stroke="#59666D" strokeWidth="2"/>{hit}</React.Fragment>}
      if(e.type==='Porta'){const handle=point(q,e.swing==='right'?u1+.14*(u2-u1):u2-.14*(u2-u1),(v1+v2)*.53);return <React.Fragment key={e.id}><Path d={quad(a,b,c,d)} fill={P.f} stroke={active?BLUE:P.l} strokeWidth={active?2.2:1.4}/><Path d={quad(point(q,u1+.04*(u2-u1),v1+.04*(v2-v1)),point(q,u2-.04*(u2-u1),v1+.04*(v2-v1)),point(q,u2-.04*(u2-u1),v2-.04*(v2-v1)),point(q,u1+.04*(u2-u1),v2-.04*(v2-v1)))} fill="none" stroke="#84613F" strokeWidth=".8"/><Circle cx={handle[0]} cy={handle[1]} r="1.7" fill="#3C342D"/>{hit}</React.Fragment>}
      return <React.Fragment key={e.id}><Path d={quad(a,b,c,d)} fill="#E8DDD0" stroke={active?BLUE:'#74695F'} strokeWidth={active?2:1.2}/>{hit}</React.Fragment>;
    }
    const [ox,oy]=depthVec(role,e),aa=[a[0]+ox,a[1]+oy],bb=[b[0]+ox,b[1]+oy],cc=[c[0]+ox,c[1]+oy],dd=[d[0]+ox,d[1]+oy];
    const front=quad(aa,bb,cc,dd),top=quad(a,b,bb,aa),leftSide=quad(a,d,dd,aa),rightSide=quad(b,c,cc,bb),bottom=quad(d,c,cc,dd);
    const ctr=[(aa[0]+bb[0]+cc[0]+dd[0])/4,(aa[1]+bb[1]+cc[1]+dd[1])/4];
    const frontHit=<Path d={front} fill="transparent" stroke="transparent" strokeWidth="8" onPress={stop(()=>onSelectElement?.(e.id,e.wall))}/>;
    return <React.Fragment key={e.id}>
      <Path d={quad([aa[0]+4,aa[1]+5],[bb[0]+4,bb[1]+5],[cc[0]+4,cc[1]+5],[dd[0]+4,dd[1]+5])} fill="#1D252B" opacity=".12"/>
      <Path d={leftSide} fill={P.s} stroke={P.l} strokeWidth="1"/><Path d={rightSide} fill={P.s} stroke={P.l} strokeWidth="1"/><Path d={top} fill={P.t} stroke={P.l} strokeWidth="1"/><Path d={bottom} fill={P.s} stroke={P.l} strokeWidth=".8"/><Path d={front} fill={P.f} stroke={active?BLUE:P.l} strokeWidth={active?2.3:1.35}/>
      {e.type==='Geladeira'?<><Line x1={mix(aa,dd,.38)[0]} y1={mix(aa,dd,.38)[1]} x2={mix(bb,cc,.38)[0]} y2={mix(bb,cc,.38)[1]} stroke="#808A90" strokeWidth=".8"/><Line x1={mix(bb,cc,.14)[0]-3} y1={mix(bb,cc,.14)[1]} x2={mix(bb,cc,.34)[0]-3} y2={mix(bb,cc,.34)[1]} stroke="#717B81" strokeWidth="1.2"/><Line x1={mix(bb,cc,.52)[0]-3} y1={mix(bb,cc,.52)[1]} x2={mix(bb,cc,.72)[0]-3} y2={mix(bb,cc,.72)[1]} stroke="#717B81" strokeWidth="1.2"/></>:null}
      {e.type==='Fogão'?<><Path d={quad(mix(aa,dd,.40),mix(bb,cc,.40),mix(bb,cc,.78),mix(aa,dd,.78))} fill="#252B2F" stroke="#101416" strokeWidth=".7"/><Path d={quad(mix(aa,dd,.46),mix(bb,cc,.46),mix(bb,cc,.70),mix(aa,dd,.70))} fill="#526069" stroke="#8D969B" strokeWidth=".5"/>{[.18,.38,.62,.82].map((t,k)=>{const pt=mix(aa,bb,t);return <Circle key={k} cx={pt[0]} cy={pt[1]+3} r="1.4" fill="#15191C"/>})}</>:null}
      {e.type==='Cooktop'?<>{[.2,.4,.6,.8].map((t,k)=>{const pt=mix(aa,bb,t);return <Circle key={k} cx={pt[0]} cy={pt[1]+3} r="1.5" fill="#15191C" stroke="#A2AAAE" strokeWidth=".4"/>})}</>:null}
      {e.type==='Pia'?<><Path d={quad(mix(a,aa,.25),mix(b,bb,.25),mix(b,bb,.78),mix(a,aa,.78))} fill="#F2F4F4" stroke="#657075" strokeWidth=".7"/><Path d={quad(mix(mix(a,b,.32),mix(aa,bb,.32),.42),mix(mix(a,b,.68),mix(aa,bb,.68),.42),mix(mix(a,b,.68),mix(aa,bb,.68),.72),mix(mix(a,b,.32),mix(aa,bb,.32),.72))} fill="#B8C3C7" stroke="#687379" strokeWidth=".6"/></>:null}
      {(e.type==='Cama solteiro'||e.type==='Cama casal'||e.type==='Beliche')?<><Line x1={mix(aa,dd,.28)[0]} y1={mix(aa,dd,.28)[1]} x2={mix(bb,cc,.28)[0]} y2={mix(bb,cc,.28)[1]} stroke="#9B8E7E" strokeWidth=".8"/><Rect x={ctr[0]-5} y={ctr[1]-3} width="10" height="6" rx="2" fill="#FAF7F1" stroke="#9B8E7E" strokeWidth=".5"/></>:null}
      {e.type==='Televisão'?<Path d={front} fill="#27323A" stroke={active?BLUE:'#111820'} strokeWidth={active?2.3:1.4}/>:null}
      {e.type==='Mesa'?<><Line x1={dd[0]} y1={dd[1]} x2={dd[0]} y2={dd[1]+7} stroke="#6E5A46" strokeWidth="1.4"/><Line x1={cc[0]} y1={cc[1]} x2={cc[0]} y2={cc[1]+7} stroke="#6E5A46" strokeWidth="1.4"/></>:null}
      {e.type==='Máquina de lavar'?<Circle cx={ctr[0]} cy={ctr[1]+2} r={Math.max(4,Math.min(10,Math.abs(bb[0]-aa[0])*.24))} fill="#C2D4DC" stroke="#6C7A82" strokeWidth=".9"/>:null}
      {frontHit}
    </React.Fragment>;
  };
  const wall=(q,i,role,fill)=>{
    const sh=role==='left'?[-9,-6]:role==='right'?[9,-6]:[0,-9],back=q.map(p=>[p[0]+sh[0],p[1]+sh[1]]),topFace=quad(back[0],back[1],q[1],q[0]),outer=role==='left'?quad(back[0],q[0],q[3],back[3]):role==='right'?quad(q[1],back[1],back[2],q[2]):quad(back[0],q[0],q[3],back[3]);
    const active=wallHighlight&&i===selectedWall;
    return <React.Fragment key={`w${i}`}><Path d={qpath(back)} fill="#A9A39B" stroke="#484E52" strokeWidth="1.2"/><Path d={topFace} fill="#C6C0B7" stroke="#484E52" strokeWidth="1"/><Path d={outer} fill="#B7B0A7" stroke="#484E52" strokeWidth="1"/><Path d={qpath(q)} fill={fill} stroke={active?BLUE:'#30363A'} strokeWidth={active?3:2.1} onPress={stop(()=>onSelectWall?.(i))}/><Line x1={q[3][0]} y1={q[3][1]} x2={q[2][0]} y2={q[2][1]} stroke="#6E675F" strokeWidth="2.6"/><SvgText x={point(q,.5,.07)[0]} y={point(q,.5,.07)[1]} textAnchor="middle" fontSize="7" fontWeight="700" fill={active?BLUE:'#697076'}>PAREDE {String.fromCharCode(65+i)}</SvgText></React.Fragment>;
  };
  const wallObjects=(q,i,role)=>elems.filter(e=>e.wall===i).map(e=>renderObj(e,q,i,role));
  const defs=<Defs><LinearGradient id="floorGrad" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#EEE7DC"/><Stop offset="1" stopColor="#C8BAA7"/></LinearGradient><LinearGradient id="wallBack" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#FFFDF8"/><Stop offset="1" stopColor="#EDE7DE"/></LinearGradient><LinearGradient id="wallSide" x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#D7D2CA"/><Stop offset="1" stopColor="#F7F3EC"/></LinearGradient><LinearGradient id="ceilGrad" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#F7F9FA"/><Stop offset="1" stopColor="#DEE4E8"/></LinearGradient></Defs>;
  const perspDims=(backIdx,leftIdx,rightIdx,lx,rx)=>{
    const backW=room.lengths[backIdx]||0, roomH=room.height||0, leftLen=room.lengths[leftIdx]||0, rightLen=room.lengths[rightIdx]||0;
    const y=22, dim=BLUE;
    return <React.Fragment>
      <Line x1={lx} y1={y} x2={rx} y2={y} stroke={dim} strokeWidth="1.1"/><Line x1={lx} y1={y-4} x2={lx} y2={y+5} stroke={dim}/><Line x1={rx} y1={y-4} x2={rx} y2={y+5} stroke={dim}/>
      <Rect x={(lx+rx)/2-24} y={y-9} width="48" height="15" rx="5" fill="#FFF" stroke="#C7DCFA" strokeWidth=".6"/><SvgText x={(lx+rx)/2} y={y+2} textAnchor="middle" fontSize="8.8" fontWeight="800" fill={dim}>{numFmt(backW)} m</SvgText>
      <Line x1={width-13} y1="42" x2={width-13} y2={height*.67} stroke={dim} strokeWidth="1.05"/><Line x1={width-17} y1="42" x2={width-9} y2="42" stroke={dim}/><Line x1={width-17} y1={height*.67} x2={width-9} y2={height*.67} stroke={dim}/>
      <Rect x={width-24} y={height*.35-20} width="16" height="43" rx="5" fill="#FFF" stroke="#C7DCFA" strokeWidth=".6"/><SvgText x={width-16} y={height*.35+2} textAnchor="middle" fontSize="8.3" fontWeight="800" fill={dim} transform={`rotate(90 ${width-16} ${height*.35})`}>{numFmt(roomH)}</SvgText>
      <SvgText x="18" y={height-13} fontSize="8.2" fontWeight="800" fill={dim}>{numFmt(leftLen)} m</SvgText><SvgText x={width-50} y={height-13} fontSize="8.2" fontWeight="800" fill={dim}>{numFmt(rightLen)} m</SvgText>
    </React.Fragment>;
  };
  // Perspectiva de ambiente baseada em uma única câmera: paredes e piso compartilham as mesmas quinas.
  const floorY=height*.67,bottomY=height-5;
  const floor2=(c)=>{
    const nearL=[8,bottomY],nearR=[width-8,bottomY],back=[c,floorY];
    const poly=quad(back,back,nearR,nearL).replace(`L ${back[0]} ${back[1]} `,'');
    return <React.Fragment><Path d={`M ${back[0]} ${back[1]} L ${nearR[0]} ${nearR[1]} L ${nearL[0]} ${nearL[1]} Z`} fill="url(#floorGrad)" stroke="#414A50" strokeWidth="1.7" onPress={onFree}/>
      {[.12,.25,.38,.50,.62,.75,.88].map((t,i)=><Line key={`r2${i}`} x1={back[0]} y1={back[1]} x2={nearL[0]+(nearR[0]-nearL[0])*t} y2={bottomY} stroke="#988D82" strokeWidth=".55" opacity=".62"/>)}
      {[.18,.34,.50,.66,.80,.91].map((t,i)=>{const k=1-Math.pow(1-t,1.65),l=mix(back,nearL,k),r=mix(back,nearR,k);return <Line key={`c2${i}`} x1={l[0]} y1={l[1]} x2={r[0]} y2={r[1]} stroke="#988D82" strokeWidth=".55" opacity=".58"/>})}
    </React.Fragment>
  };
  const floor3=(lx,rx)=>{
    const bl=[lx,floorY],br=[rx,floorY],fl=[8,bottomY],fr=[width-8,bottomY];
    return <React.Fragment><Path d={quad(bl,br,fr,fl)} fill="url(#floorGrad)" stroke="#414A50" strokeWidth="1.8" onPress={onFree}/>
      {[.08,.20,.32,.44,.56,.68,.80,.92].map((t,i)=>{const a=mix(bl,br,t),b=mix(fl,fr,t);return <Line key={`r3${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#988D82" strokeWidth=".55" opacity=".62"/>})}
      {[.14,.28,.43,.58,.72,.84,.93].map((t,i)=>{const k=1-Math.pow(1-t,1.7),l=mix(bl,fl,k),r=mix(br,fr,k);return <Line key={`c3${i}`} x1={l[0]} y1={l[1]} x2={r[0]} y2={r[1]} stroke="#988D82" strokeWidth=".55" opacity=".58"/>})}
    </React.Fragment>
  };
  if(count===1){const q=[[34,42],[width-34,42],[width-34,height-28],[34,height-28]];return <Svg width={width} height={height}>{defs}<Rect width={width} height={height} fill="#E7ECEF" onPress={onFree}/>{wall(q,0,'back','url(#wallBack)')}{wallObjects(q,0,'back')}</Svg>}
  if(count===2){
    const c=width*.50, topY=34, outerTop=74, nearY=bottomY;
    const qL=[[8,outerTop],[c,topY],[c,floorY],[8,nearY]],qR=[[c,topY],[width-8,outerTop],[width-8,nearY],[c,floorY]];
    return <Svg width={width} height={height}>{defs}<Rect width={width} height={height} fill="#E8EDF0" onPress={onFree}/>
      {floor2(c)}
      {wall(qL,0,'left','url(#wallSide)')}{wall(qR,1,'right','url(#wallBack)')}
      <Line x1={c} y1={topY} x2={c} y2={floorY} stroke="#2C3236" strokeWidth="3.5"/>
      {wallObjects(qL,0,'left')}{wallObjects(qR,1,'right')}
    </Svg>
  }
  const back=count===4?selectedWall%4:selectedWall%3,left=count===4?(back+3)%4:(back+2)%3,right=count===4?(back+1)%4:(back+1)%3;
  const lx=width*.25,rx=width*.75,topY=42,outerTop=79;
  const qB=[[lx,topY],[rx,topY],[rx,floorY],[lx,floorY]],qL=[[8,outerTop],[lx,topY],[lx,floorY],[8,bottomY]],qR=[[rx,topY],[width-8,outerTop],[width-8,bottomY],[rx,floorY]];
  return <Svg width={width} height={height}>{defs}<Rect width={width} height={height} fill="#E7ECEF" onPress={onFree}/>
    <Path d={quad([8,outerTop],[width-8,outerTop],[rx,topY],[lx,topY])} fill="url(#ceilGrad)" stroke="#B8C1C7" strokeWidth=".8"/>
    {floor3(lx,rx)}
    {wall(qL,left,'left','url(#wallSide)')}{wall(qB,back,'back','url(#wallBack)')}{wall(qR,right,'right','url(#wallSide)')}
    <Line x1={lx} y1={topY} x2={lx} y2={floorY} stroke="#2C3236" strokeWidth="3.4"/><Line x1={rx} y1={topY} x2={rx} y2={floorY} stroke="#2C3236" strokeWidth="3.4"/>
    <Line x1="8" y1={bottomY} x2={lx} y2={floorY} stroke="#4A5257" strokeWidth="2.2"/><Line x1={rx} y1={floorY} x2={width-8} y2={bottomY} stroke="#4A5257" strokeWidth="2.2"/>
    {wallObjects(qL,left,'left')}{wallObjects(qB,back,'back')}{wallObjects(qR,right,'right')}{perspDims(back,left,right,lx,rx)}</Svg>;
}

function NotesModal({visible, initial='', onClose, onSave}){
  const [text,setText]=useState(initial||'');
  useEffect(()=>{if(visible)setText(initial||'')},[visible,initial]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><KeyboardAvoidingView style={styles.sheetBackdrop} behavior={Platform.OS==='ios'?'padding':undefined}><Pressable style={{flex:1}} onPress={onClose}/><View style={styles.sheet}><View style={styles.sheetHandle}/><Text style={styles.modalTitle}>Notas do ambiente</Text><Text style={styles.formHint}>Registre detalhes que não cabem nas medidas.</Text><TextInput multiline autoFocus value={text} onChangeText={setText} placeholder="Ex.: parede fora de esquadro, cliente vai trocar a geladeira..." placeholderTextColor="#94A3B8" style={styles.notesInput}/><Button title="Salvar nota" onPress={()=>{onSave(text.trim());onClose()}}/></View></KeyboardAvoidingView></Modal>;
}

function SummaryModal({visible,room,onClose}){
  if(!room)return null;
  const groups=GROUPS.map(g=>({name:g.key,items:(room.elements||[]).filter(e=>g.items.includes(e.type))})).filter(g=>g.items.length);
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}><View style={styles.screen}><Header title="Resumo técnico" subtitle={room.name} onBack={onClose}/><ScrollView contentContainerStyle={styles.summaryPage}><View style={styles.summaryTechBox}><Text style={styles.sectionKicker}>PAREDES</Text>{(room.lengths||[]).map((v,i)=><View key={i} style={styles.summaryTechRow}><Text style={styles.summaryTechStrong}>Parede {String.fromCharCode(65+i)}</Text><Text style={styles.summaryTechValue}>{mFmt(v)} × {mFmt(room.height||2.65)}</Text></View>)}</View>{groups.map(g=><View key={g.name} style={styles.summaryTechBox}><Text style={styles.sectionKicker}>{g.name.toUpperCase()}</Text>{g.items.map(e=><View key={e.id} style={styles.summaryTechItem}><Text style={styles.summaryTechStrong}>{e.type} · {(isFreePlanType(e.type)||e.free===true)?'Livre no ambiente':`Parede ${String.fromCharCode(65+elementWallIndex(e,room))}`}</Text><Text style={styles.summaryTechValue}>{dimensionText(e)}</Text><Text style={styles.summaryTechPosition}>{(isFreePlanType(e.type)||e.free===true)?'Posição · livre na planta':<>Posição · esquerda {mFmt(e.left)} · direita {mFmt(Math.max(0,(room.lengths[e.wall]||0)-e.left-e.width))} · piso {mFmt(e.bottom)}</>}</Text></View>)}</View>)}{room.notes?<View style={styles.summaryTechBox}><Text style={styles.sectionKicker}>NOTAS</Text><Text style={styles.summaryNotes}>{room.notes}</Text></View>:null}</ScrollView></View></Modal>;
}

function PlanEditor({ project, room, draftMeta, onBack, onSave, onSaveExit, onChooseCount, onPhotos, onFinish, onExportPreview }) {
  const canvasW=APP_W-22, canvasH=Math.min(368,Math.max(338,RAW_H*.405));
  const [selected,setSelected]=useState(0),[editWall,setEditWall]=useState(null),[addOpen,setAddOpen]=useState(false),[addGroup,setAddGroup]=useState('Aberturas'),[selectedElement,setSelectedElement]=useState(null),[editElementOpen,setEditElementOpen]=useState(false),[viewMode,setViewMode]=useState('plan'),[notesOpen,setNotesOpen]=useState(false),[summaryOpen,setSummaryOpen]=useState(false);
  const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0}),[canvasFree,setCanvasFree]=useState(true),[focusedCota,setFocusedCota]=useState(null); const pinchStart=useRef(1),panStart=useRef({x:0,y:0}),pinchingRef=useRef(false),tapConsumedRef=useRef(false);
  const walls=useMemo(()=>room?deriveWalls(room.wallCount,room.lengths,canvasW,canvasH):[],[room?.wallCount,room?.lengths,canvasW,canvasH]);
  if(!room){
    const options=[{n:1,label:'1 parede',shape:'—'},{n:2,label:'2 paredes',shape:'⌞'},{n:3,label:'3 paredes',shape:'⊔'},{n:4,label:'4 paredes',shape:'□'}];
    return <View style={styles.editorScreen}><View style={styles.editorTop}><Pressable onPress={onBack}><Text style={styles.back}>‹ Voltar</Text></Pressable><View style={{flex:1,marginHorizontal:10}}><Text style={styles.editorTitle}>{draftMeta?.room||'Nova medição'}</Text><Text style={styles.editorSub}>{draftMeta?.client} · {draftMeta?.project}</Text></View></View><View style={styles.toolBar}><Text style={styles.toolLabel}>Escolha quantas paredes quer medir.</Text></View><View style={[styles.planCanvas,{width:canvasW,height:canvasH}]}><GridBackground step={18}/><View style={styles.chooseOverlay}><Text style={styles.floorPreviewText}>Piso / vista superior</Text></View></View><View style={styles.wallCountRowEditor}>{options.map(o=><Pressable key={o.n} onPress={()=>onChooseCount(o.n)} style={styles.wallCountCardEditor}><Text style={styles.wallShape}>{o.shape}</Text><Text style={styles.wallCountText}>{o.label}</Text></Pressable>)}</View></View>;
  }
  const pinch=Gesture.Pinch().runOnJS(true).onBegin(()=>{pinchingRef.current=true;pinchStart.current=zoom}).onUpdate(e=>setZoom(clamp(pinchStart.current*e.scale,.8,3.2))).onFinalize(()=>{pinchingRef.current=false});
  const pan=Gesture.Pan().minPointers(canvasFree?1:2).maxPointers(2).runOnJS(true).onBegin(()=>panStart.current=offset).onUpdate(e=>setOffset({x:panStart.current.x+e.translationX,y:panStart.current.y+e.translationY}));
  const canvasTap=Gesture.Tap().numberOfTaps(1).maxDistance(8).runOnJS(true)
    .onBegin(()=>{tapConsumedRef.current=false})
    .onEnd((_e,ok)=>{if(ok)setTimeout(()=>{if(!tapConsumedRef.current)freeCanvas()},40)});
  const gesture=Gesture.Simultaneous(pinch,pan,canvasTap);
  const updateWallMeasurements=(i,width,height)=>{const lengths=[...room.lengths];lengths[i]=width;onSave({...room,lengths,height},false);setEditWall(null)};
  const changeCount=n=>{let lengths=[...room.lengths];while(lengths.length<n) lengths.push(lengths.length%2===0?3.2:2.8);lengths=lengths.slice(0,n);const elements=(room.elements||[]).filter(e=>isFreePlanType(e.type)||e.free===true||e.wall<n);setSelected(Math.min(selected,n-1));onSave({...room,wallCount:n,lengths,elements},false)};
  const openGroup=g=>{setAddGroup(g);setAddOpen(true)};
  const addElement=type=>{const d=DEFAULTS[type]||{width:.2,height:.2,bottom:0};const wallW=room.lengths[selected]||3;const free=isFreePlanType(type);const internal=isInternalWall(type);const anchorWall=selected;let left=0;
    if(internal){const t=internalWallThickness({...d,type});left=clamp((wallW-t)/2,0,Math.max(0,wallW-t));}
    else if(!free){const segments=wallAvailableSegments(room,anchorWall).filter(seg=>seg.width>=Number(d.width||.2));const seg=(segments.length?segments:wallAvailableSegments(room,anchorWall)).sort((a,b)=>b.width-a.width)[0]||{start:0,end:wallW,width:wallW};left=clamp(seg.start+(seg.width-Number(d.width||.2))/2,seg.start,Math.max(seg.start,seg.end-Number(d.width||.2)));}
    const el={id:uid(),type,wall:anchorWall,width:d.width,height:d.height,bottom:d.bottom,depth:d.depth||.15,thickness:d.thickness,swing:d.swing||undefined,left,...(free?{free:true,freeX:.50,freeY:.58}:{free:false})};onSave({...room,elements:[...(room.elements||[]),el]},false);setSelectedElement(el.id);setCanvasFree(false);setAddOpen(false)};
  const updateElement=o=>{const fixed=constrainElementToWallSegments(room,o);onSave({...room,elements:(room.elements||[]).map(e=>e.id===fixed.id?fixed:e)},false)};
  const deleteSelected=()=>{if(!selectedElement)return;confirmDelete('Excluir item','Remover este item da medição?',()=>{onSave({...room,elements:(room.elements||[]).filter(e=>e.id!==selectedElement)},false);setSelectedElement(null);setEditElementOpen(false)});};
  const selectedWall=walls[selected], selectedObj=(room.elements||[]).find(e=>e.id===selectedElement), selectedSegment=selectedObj?wallSegmentForElement(room,selectedObj):null, modalObj=(selectedObj&&selectedSegment&&!isInternalWall(selectedObj.type)&&!isFreePlanType(selectedObj.type)&&selectedObj.free!==true)?{...selectedObj,left:Number(selectedObj.left||0)-selectedSegment.start}:selectedObj, options=[{n:1,label:'1',shape:'—'},{n:2,label:'2',shape:'⌞'},{n:3,label:'3',shape:'⊔'},{n:4,label:'4',shape:'□'}];
  const frontW=room.lengths[selected]||3.2, frontH=room.height||2.65, frontPx=Math.min((canvasW-54)/frontW,(canvasH-56)/frontH),
    frontObjects=(room.elements||[]).filter(e=>elementWallIndex(e,room)===selected&&(!isFreePlanType(e.type)||isInternalWall(e.type))&&(e.free!==true||isInternalWall(e.type))).map(e=>frontObjectForRoom(constrainElementToWallSegments(room,e),selected,room));
  const planPpm=walls?.length?Math.max(20,Math.hypot(walls[0].b.x-walls[0].a.x,walls[0].b.y-walls[0].a.y)/Math.max(.1,room.lengths?.[0]||1)):70;
  const frontUpdate=o=>updateElement(o);
  function freeCanvas(){setSelectedElement(null);setCanvasFree(true);setFocusedCota(null)}
  const chooseWall=i=>{tapConsumedRef.current=true;setSelected(i);setSelectedElement(null);setCanvasFree(false);setFocusedCota(null)};
  const chooseElement=(id,wallIndex)=>{tapConsumedRef.current=true;setSelectedElement(id);if(wallIndex!=null)setSelected(wallIndex);setCanvasFree(false);setFocusedCota(null)};
  const changeView=m=>{setViewMode(m);setSelectedElement(null);setCanvasFree(true);setFocusedCota(null);setOffset({x:0,y:0});setZoom(1)};
  // Quando há algo selecionado, uma camada transparente fica ACIMA do desenho técnico
  // e ABAIXO dos objetos. Assim, tocar no piso/área vazia sempre desseleciona, inclusive
  // no iPhone, sem impedir que o objeto selecionado continue recebendo arraste/toque.
  const hasSelection=!!selectedObj||!canvasFree;
  return <View style={styles.editorScreen}><View style={styles.editorTop}><Pressable onPress={onBack}><Text style={styles.back}>‹ Projeto</Text></Pressable><View style={{flex:1,marginHorizontal:10}}><Text style={styles.editorTitle}>{room.name}</Text><Text style={styles.editorSub}>{project.client} · {project.name}</Text></View><Pressable onPress={onSaveExit} style={styles.saveBtn}><Text style={styles.saveBtnText}>Salvar</Text></Pressable></View>
    <View style={styles.toolBar}><Text style={styles.viewsLabel}>Vistas</Text><View style={styles.viewSegments}><Pressable onPress={()=>changeView('plan')} style={[styles.viewSegment,viewMode==='plan'&&styles.viewSegmentOn]}><Text style={[styles.viewSegmentText,viewMode==='plan'&&styles.viewSegmentTextOn]}>Planta</Text></Pressable><Pressable onPress={()=>changeView('front')} style={[styles.viewSegment,viewMode==='front'&&styles.viewSegmentOn]}><Text style={[styles.viewSegmentText,viewMode==='front'&&styles.viewSegmentTextOn]}>Paredes</Text></Pressable></View><Text style={styles.zoomBadge}>{Math.round(zoom*100)}%</Text></View>
    {viewMode==='front'?<View style={styles.wallViewSelector}><Text style={styles.wallViewLabel}>VISTA FRONTAL</Text><View style={styles.wallViewTabs}>{room.lengths.map((_v,i)=><Pressable key={i} onPress={()=>{setSelected(i);setSelectedElement(null);setCanvasFree(true);setOffset({x:0,y:0});setZoom(1)}} style={[styles.wallViewTab,selected===i&&styles.wallViewTabOn]}><Text style={[styles.wallViewTabText,selected===i&&styles.wallViewTabTextOn]}>Parede {String.fromCharCode(65+i)}</Text></Pressable>)}</View></View>:null}
    {viewMode==='plan'?<GestureDetector gesture={gesture}><View style={[styles.planCanvas,{width:canvasW,height:canvasH}]}><GridBackground step={18}/><View pointerEvents="box-none" style={{flex:1,transform:[{translateX:offset.x},{translateY:offset.y},{scale:zoom}]}}><PlanTechnicalLayer walls={walls} room={room} selected={selected} selectedElement={selectedElement} canvasFree={canvasFree} onChooseWall={chooseWall} onEditWall={setEditWall} width={canvasW} height={canvasH} focusedCota={focusedCota} onFocusCota={setFocusedCota}/>{(room.elements||[]).filter(e=>PLAN_GROUPS.some(k=>GROUPS.find(g=>g.key===k)?.items.includes(e.type))&&!isInternalWall(e.type)).map(e=>walls[e.wall]?<PlanElement key={e.id} element={e} wall={walls[e.wall]} wallLength={room.lengths[e.wall]||1} wallCount={room.wallCount||4} zoom={zoom} selected={e.id===selectedElement} onSelect={()=>chooseElement(e.id,e.wall)} onChange={updateElement} pinchingRef={pinchingRef}/>:null)}{(room.elements||[]).filter(e=>isEquipment(e.type)||isReservedSpace(e.type)||isInternalWall(e.type)).map(e=>{const free=isFreePlanType(e.type)||e.free===true;const wi=elementWallIndex(e,room);const w=walls[wi]||walls[0];const normalized=isInternalWall(e.type)?{...e,wall:wi}:e;return w?<PlanEquipmentElement key={`eq-${e.id}`} element={normalized} wall={w} wallLength={room.lengths[wi]||room.lengths[0]||1} wallCount={room.wallCount} zoom={zoom} selected={e.id===selectedElement} onSelect={()=>chooseElement(e.id,free?null:e.wall)} onChange={updateElement} pinchingRef={pinchingRef} canvasW={canvasW} canvasH={canvasH} planPpm={planPpm}/>:null})}</View></View></GestureDetector>:<GestureDetector gesture={gesture}><View style={[styles.elevCanvas,{width:canvasW,height:canvasH}]}><View pointerEvents="box-none" style={{flex:1,transform:[{translateX:offset.x},{translateY:offset.y},{scale:zoom}]}}><TechnicalElevationBase wallW={frontW} wallH={frontH} px={frontPx} width={canvasW} height={canvasH} objects={frontObjects} focusedCota={focusedCota} onFocusCota={setFocusedCota}/>{frontObjects.map(o=><WallObject key={o.id} obj={o} wallW={frontW} wallH={frontH} boardW={canvasW} boardH={canvasH} px={frontPx} selected={o.id===selectedElement} onSelect={()=>chooseElement(o.id,o.wall)} onEdit={()=>chooseElement(o.id,o.wall)} onChange={frontUpdate} pinchingRef={pinchingRef}/>)}</View></View></GestureDetector>}
    <View style={styles.selectedCard}><View style={{flex:1}}><Text style={styles.selectedKicker}>{selectedObj?'ITEM SELECIONADO':canvasFree?'NADA SELECIONADO':'PAREDE SELECIONADA'}</Text><Text style={styles.selectedTitle}>{selectedObj?(isFreePlanType(selectedObj.type)||selectedObj.free===true?`${selectedObj.type} · livre no ambiente`:`${selectedObj.type} · Parede ${String.fromCharCode(65+elementWallIndex(selectedObj,room))}`):canvasFree?'Tela livre · 1 dedo move · pinça dá zoom':`Parede ${String.fromCharCode(65+selected)} · ${mFmt(selectedWall?.length||0)}`}</Text></View>{(selectedObj||!canvasFree)?<Pressable onPress={()=>selectedObj?setEditElementOpen(true):setEditWall(selected)} style={[styles.miniBtn,styles.miniBtnPrimary]}><Text style={[styles.miniBtnText,{color:WHITE}]}>Ajustar</Text></Pressable>:null}</View>
    <View style={styles.wallCountRowCompact}>{options.map(o=><Pressable key={o.n} onPress={()=>changeCount(o.n)} style={[styles.wallCountCompact,room.wallCount===o.n&&styles.wallCountCompactOn]}><Text style={[styles.wallCompactShape,room.wallCount===o.n&&{color:WHITE}]}>{o.shape}</Text><Text style={[styles.wallCompactText,room.wallCount===o.n&&{color:WHITE}]}>{o.label} {o.n===1?'parede':'paredes'}</Text></Pressable>)}</View>
    <View style={styles.categoryDock}>{GROUPS.filter(g=>(viewMode==='front'?FRONT_GROUPS:PLAN_ADD_GROUPS).includes(g.key)).map(g=><Pressable key={g.key} onPress={()=>openGroup(g.key)} style={styles.categoryBtn}><Text style={styles.categoryIcon}>{g.icon}</Text><Text style={styles.categoryText}>{g.key}</Text></Pressable>)}</View>
    <View style={styles.finishDock}><Pressable onPress={onPhotos} style={styles.finishBtn}><Text style={styles.finishIcon}>📷</Text><Text style={styles.finishText}>Fotos</Text></Pressable><Pressable onPress={()=>setNotesOpen(true)} style={styles.finishBtn}><Text style={styles.finishIcon}>✎</Text><Text style={styles.finishText}>Notas</Text></Pressable><Pressable onPress={()=>setSummaryOpen(true)} style={styles.finishBtn}><Text style={styles.finishIcon}>☷</Text><Text style={styles.finishText}>Resumo</Text></Pressable><Pressable onPress={onFinish} style={[styles.finishBtn,styles.finishBtnPrimary]}><Text style={[styles.finishIcon,{color:WHITE}]}>✓</Text><Text style={[styles.finishText,{color:WHITE}]}>Concluir</Text></Pressable></View>
    {selectedObj?<View style={styles.adjustRow}><Text style={styles.dragHint}>{selectedObj.type} selecionado · use Ajustar para editar</Text><Pressable onPress={deleteSelected} style={styles.quickDelete}><Text style={styles.quickDeleteText}>Excluir</Text></Pressable></View>:null}
    <NotesModal visible={notesOpen} initial={room.notes||''} onClose={()=>setNotesOpen(false)} onSave={notes=>onSave({...room,notes},false)}/><SummaryModal visible={summaryOpen} room={room} onClose={()=>setSummaryOpen(false)}/><WallMeasureModal visible={editWall!==null} title={`Parede ${String.fromCharCode(65+(editWall||0))}`} initialWidth={editWall!==null?(room.lengths[editWall]||0):0} initialHeight={room.height||2.65} onCancel={()=>setEditWall(null)} onSave={(width,height)=>updateWallMeasurements(editWall,width,height)}/><AddSheet visible={addOpen} initialGroup={addGroup} allowedGroups={viewMode==='front'?FRONT_GROUPS:PLAN_ADD_GROUPS} excludedItems={viewMode==='front'?FREE_PLAN_TYPES:[]} onClose={()=>setAddOpen(false)} onAdd={addElement} wallIndex={selected}/><ObjectModal visible={editElementOpen} object={modalObj} wallW={(selectedObj&&selectedSegment&&!isInternalWall(selectedObj.type)&&!isFreePlanType(selectedObj.type)&&selectedObj.free!==true)?selectedSegment.width:(room.lengths[elementWallIndex(selectedObj||{wall:selected},room)]||3.2)} wallH={room.height||2.65} onClose={()=>setEditElementOpen(false)} onSave={o=>updateElement((selectedObj&&selectedSegment&&!isInternalWall(selectedObj.type)&&!isFreePlanType(selectedObj.type)&&selectedObj.free!==true)?{...o,left:Number(o.left||0)+selectedSegment.start}:o)} onDelete={deleteSelected}/>
  </View>;
}

function PlanPreviewStatic({room,width=360,height=230}){
  // Exportação usa a MESMA composição visual da tela Planta.
  // Assim, o que aparece no levantamento é o que o cliente recebe na pré-visualização.
  const walls=useMemo(()=>deriveWalls(room.wallCount,room.lengths,width,height),[room.wallCount,room.lengths,width,height]);
  const planPpm=walls?.length?Math.max(20,Math.hypot(walls[0].b.x-walls[0].a.x,walls[0].b.y-walls[0].a.y)/Math.max(.1,room.lengths?.[0]||1)):70;
  const noop=()=>{};
  return <View style={[styles.planCanvas,{width,height,overflow:'hidden'}]} pointerEvents="none">
    <GridBackground step={18}/>
    <View pointerEvents="none" style={{flex:1}}>
      <PlanTechnicalLayer walls={walls} room={room} selected={0} selectedElement={null} canvasFree={true} width={width} height={height}/>
      {(room.elements||[]).filter(e=>PLAN_GROUPS.some(k=>GROUPS.find(g=>g.key===k)?.items.includes(e.type))).map(e=>{
        const w=walls[e.wall];
        return w?<PlanElement key={`preview-${e.id}`} element={e} wall={w} wallLength={room.lengths[e.wall]||1} wallCount={room.wallCount||4} zoom={1} selected={false} onSelect={noop} onChange={noop}/>:null;
      })}
      {(room.elements||[]).filter(e=>isEquipment(e.type)||isReservedSpace(e.type)||isInternalWall(e.type)).map(e=>{
        const free=isFreePlanType(e.type)||e.free===true,wi=elementWallIndex(e,room),w=walls[wi]||walls[0],normalized=isInternalWall(e.type)?{...e,wall:wi}:e;
        return w?<PlanEquipmentElement key={`preview-eq-${e.id}`} element={normalized} wall={w} wallLength={room.lengths[wi]||room.lengths[0]||1} wallCount={room.wallCount||4} zoom={1} selected={false} onSelect={noop} onChange={noop} canvasW={width} canvasH={height} planPpm={planPpm}/>:null;
      })}
    </View>
  </View>;
}
function FrontPreviewStatic({room,wallIndex=0,width=360,height=230}){
  const wallW=room.lengths[wallIndex]||3.2,wallH=room.height||2.65,px=Math.min((width-60)/wallW,(height-60)/wallH),
    objects=(room.elements||[]).filter(e=>elementWallIndex(e,room)===wallIndex&&(!isFreePlanType(e.type)||isInternalWall(e.type))&&(e.free!==true||isInternalWall(e.type))).map(e=>isInternalWall(e.type)?frontObjectForRoom(e,wallIndex,room):constrainElementToWallSegments(room,e)).sort((a,b)=>visualLayer(a)-visualLayer(b));
  return <View style={{width,height,overflow:'hidden',borderRadius:12}}><TechnicalElevationBase wallW={wallW} wallH={wallH} px={px} width={width} height={height}/>{objects.map(o=>{const opening=isOpening(o.type),equip=isEquipment(o.type),reserved=isReservedSpace(o.type),structure=isStructure(o.type),point=isPoint(o.type),internal=isInternalWall(o.type),vw=internal?Math.max(5,o.width*px):Math.max(o.width*px,opening||equip||reserved?28:18),vh=internal?Math.max(20,o.height*px):(o.type==='Pia'?Math.max(o.height*px,12):Math.max(o.height*px,opening||equip||reserved?26:18)),x=27+o.left*px,y=46+(wallH-o.bottom-o.height)*px;return <View key={o.id} pointerEvents="none" style={{position:'absolute',left:x,top:y,width:vw,height:vh,borderWidth:internal?1.4:1,borderColor:internal?'#59636B':'#5B6670',backgroundColor:internal?'#D4D9DD':point?'transparent':'rgba(255,255,255,.2)',zIndex:visualLayer(o)}}>{internal?null:<ElementVisual type={o.type} width={vw} height={vh}/>}</View>})}</View>;
}
function ExportPreview({project,room,onBack,onExport}){
  const [frontWall,setFrontWall]=useState(0),[photoIndex,setPhotoIndex]=useState(0);
  const previewW=Math.min(APP_W-36,404),editorCanvasW=APP_W-22,editorCanvasH=Math.min(368,Math.max(338,RAW_H*.405)),planPreviewH=Math.round(previewW*(editorCanvasH/editorCanvasW)),previewH=238,photos=room.photos||[];
  const relevantWalls=(room.lengths||[]).map((_v,i)=>i).filter(i=>(room.elements||[]).some(e=>e.wall===i&&!isFreePlanType(e.type)&&e.free!==true));
  const wallChoices=relevantWalls.length?relevantWalls:(room.lengths||[]).map((_v,i)=>i);
  useEffect(()=>{if(!wallChoices.includes(frontWall))setFrontWall(wallChoices[0]||0)},[room.id]);
  return <View style={styles.screen}><Header title="Exportar" subtitle={`${project.client} · ${project.name} · ${room.name}`} onBack={onBack}/><ScrollView contentContainerStyle={styles.exportPage} showsVerticalScrollIndicator={false}>
    <View style={styles.exportIntro}><Text style={styles.exportIntroTitle}>Pré-visualização</Text><Text style={styles.exportIntroText}>A planta principal repete a mesma vista técnica usada na medição. Paredes, fotos e ficha técnica entram como complemento.</Text></View>
    <View style={styles.exportCard}><Text style={styles.exportCardTitle}>PLANTA PRINCIPAL</Text><PlanPreviewStatic room={room} width={previewW} height={planPreviewH}/></View>
    <View style={styles.exportCard}><View style={styles.exportCardHead}><Text style={styles.exportCardTitle}>VISTA FRONTAL</Text><View style={styles.exportChips}>{wallChoices.map(i=><Pressable key={i} onPress={()=>setFrontWall(i)} style={[styles.exportChip,frontWall===i&&styles.exportChipOn]}><Text style={[styles.exportChipText,frontWall===i&&styles.exportChipTextOn]}>{String.fromCharCode(65+i)}</Text></Pressable>)}</View></View><FrontPreviewStatic room={room} wallIndex={frontWall} width={previewW} height={previewH}/></View>
    <View style={styles.exportCard}><View style={styles.exportCardHead}><Text style={styles.exportCardTitle}>FOTOS DO AMBIENTE</Text>{photos.length>1?<View style={styles.exportChips}>{photos.map((_p,i)=><Pressable key={i} onPress={()=>setPhotoIndex(i)} style={[styles.exportChip,photoIndex===i&&styles.exportChipOn]}><Text style={[styles.exportChipText,photoIndex===i&&styles.exportChipTextOn]}>{i+1}</Text></Pressable>)}</View>:null}</View>{photos[photoIndex]?<Image source={{uri:photos[photoIndex].uri}} style={[styles.exportPhoto,{width:previewW}]}/>:<View style={[styles.exportEmptyVisual,{width:previewW}]}><Text style={styles.exportEmptyText}>Nenhuma foto adicionada ao ambiente.</Text></View>}</View>
    <View style={styles.exportCard}><Text style={styles.exportCardTitle}>FICHA TÉCNICA</Text><View style={styles.exportTechBox}>{(room.lengths||[]).map((v,i)=><View key={i} style={styles.exportTechRow}><Text style={styles.exportTechStrong}>Parede {String.fromCharCode(65+i)}</Text><Text style={styles.exportTechValue}>{mFmt(v)} × {mFmt(room.height||2.65)}</Text></View>)}{(room.elements||[]).map(e=><View key={e.id} style={styles.exportTechItem}><Text style={styles.exportTechStrong}>{e.type} · {(isFreePlanType(e.type)||e.free===true)?'Livre no ambiente':`Parede ${String.fromCharCode(65+elementWallIndex(e,room))}`}</Text><Text style={styles.exportTechValue}>{dimensionText(e)}</Text></View>)}</View></View>
    <View style={styles.exportCard}><Text style={styles.exportCardTitle}>NOTAS</Text><Text style={styles.exportNotes}>{room.notes?.trim()||'Nenhuma nota registrada para este ambiente.'}</Text></View>
  </ScrollView><View style={styles.exportFooter}><Pressable onPress={()=>onExport({frontWall,photoIndex})} style={styles.newMeasureBtn}><Text style={styles.newMeasureText}>Exportar arquivo</Text></Pressable></View></View>;
}

function ProjectExportPreview({project,onBack,onExport,onExportGw,gwExporting}){
  const exportCaptureRef=useRef(null);
  const [selected,setSelected]=useState(()=>Object.fromEntries((project.rooms||[]).map(r=>[r.id,true])));
  const primaryWall=r=>{const rel=(r.lengths||[]).map((_v,i)=>i).filter(i=>(r.elements||[]).some(e=>elementWallIndex(e,r)===i&&(!isFreePlanType(e.type)||isInternalWall(e.type))&&(e.free!==true||isInternalWall(e.type))));return rel[0]??0};
  const [wallsByRoom,setWallsByRoom]=useState(()=>Object.fromEntries((project.rooms||[]).map(r=>[r.id,primaryWall(r)])));
  const rooms=(project.rooms||[]).filter(r=>selected[r.id]);
  const previewW=Math.min(APP_W-36,404), editorCanvasW=APP_W-22, editorCanvasH=Math.min(368,Math.max(338,RAW_H*.405)), planPreviewH=Math.round(previewW*(editorCanvasH/editorCanvasW)), frontH=220;
  const toggle=id=>setSelected(v=>({...v,[id]:!v[id]}));
  const chooseWall=(roomId,i)=>setWallsByRoom(v=>({...v,[roomId]:i}));
  return <View style={styles.screen}><Header title="Exportar projeto" subtitle={`${project.client} · ${project.name}`} onBack={onBack}/><ScrollView contentContainerStyle={styles.exportPage} showsVerticalScrollIndicator={false}>
    <View ref={exportCaptureRef} collapsable={false} dataSet={{gwExportCapture:'project'}}>
    <View style={styles.exportIntro}><Text style={styles.exportIntroTitle}>Projeto completo</Text><Text style={styles.exportIntroText}>Marque os ambientes e escolha, em cada um, qual parede frontal entra no arquivo. Esta tela é a conferência antes de exportar.</Text></View>
    <View style={styles.exportCard}><Text style={styles.exportCardTitle}>AMBIENTES</Text>{(project.rooms||[]).map(r=><Pressable key={r.id} onPress={()=>toggle(r.id)} style={styles.exportTechRow}><Text style={styles.exportTechStrong}>{selected[r.id]?'☑':'☐'} {r.name}</Text><Text style={styles.exportTechValue}>{r.wallCount} paredes · {(r.elements||[]).length} itens · {(r.photos||[]).length} fotos</Text></Pressable>)}</View>
    {rooms.map(r=>{const wall=wallsByRoom[r.id]??primaryWall(r),photo=(r.photos||[])[0],wallChoices=(r.lengths||[]).map((_v,i)=>i);return <View key={r.id} style={styles.exportCard}>
      <View style={styles.exportCardHead}><Text style={styles.exportCardTitle}>{r.name.toUpperCase()}</Text><Text style={styles.exportTechValue}>{r.wallCount} paredes · {(r.elements||[]).length} itens</Text></View>
      <Text style={styles.sectionKicker}>PLANTA PRINCIPAL</Text><PlanPreviewStatic room={r} width={previewW} height={planPreviewH}/>
      <View style={[styles.exportCardHead,{marginTop:8}]}><Text style={styles.sectionKicker}>VISTA FRONTAL · PAREDE {String.fromCharCode(65+wall)}</Text><View style={styles.exportChips}>{wallChoices.map(i=><Pressable key={i} onPress={()=>chooseWall(r.id,i)} style={[styles.exportChip,wall===i&&styles.exportChipOn]}><Text style={[styles.exportChipText,wall===i&&styles.exportChipTextOn]}>{String.fromCharCode(65+i)}</Text></Pressable>)}</View></View>
      <FrontPreviewStatic room={r} wallIndex={wall} width={previewW} height={frontH}/>
      <Text style={[styles.sectionKicker,{marginTop:8}]}>FICHA TÉCNICA</Text><View style={styles.exportTechBox}>{(r.lengths||[]).map((v,i)=><View key={i} style={styles.exportTechRow}><Text style={styles.exportTechStrong}>Parede {String.fromCharCode(65+i)}</Text><Text style={styles.exportTechValue}>{mFmt(v)} × {mFmt(r.height||2.65)}</Text></View>)}{(r.elements||[]).slice(0,8).map(e=><View key={e.id} style={styles.exportTechItem}><Text style={styles.exportTechStrong}>{e.type} · {(isFreePlanType(e.type)||e.free===true)?'Livre no ambiente':`Parede ${String.fromCharCode(65+(e.wall||0))}`}</Text><Text style={styles.exportTechValue}>{dimensionText(e)}</Text></View>)}</View>
      <Text style={[styles.sectionKicker,{marginTop:8}]}>FOTO DO AMBIENTE</Text>{photo?<Image source={{uri:photo.uri}} style={[styles.exportPhoto,{width:previewW,height:190}]}/>:<View style={[styles.exportEmptyVisual,{width:previewW,height:100}]}><Text style={styles.exportEmptyText}>Nenhuma foto adicionada.</Text></View>}
      <Text style={[styles.sectionKicker,{marginTop:8}]}>NOTAS</Text><Text style={styles.exportNotes}>{r.notes?.trim()||'Nenhuma nota registrada para este ambiente.'}</Text>
    </View>})}
    {!rooms.length?<View style={styles.exportCard}><Text style={styles.exportEmptyText}>Selecione pelo menos um ambiente.</Text></View>:null}
    </View>
  </ScrollView><View style={styles.exportFooter}><View style={{flexDirection:'row',gap:8}}><Pressable disabled={!rooms.length} onPress={()=>onExport({rooms,wallsByRoom})} style={[styles.newMeasureBtn,!rooms.length&&{opacity:.4}]}><Text style={styles.newMeasureText}>Exportar arquivo</Text></Pressable><Pressable disabled={!rooms.length||gwExporting} onPress={()=>onExportGw?.({rooms,wallsByRoom,captureRef:exportCaptureRef})} style={[styles.newMeasureBtn,{backgroundColor:'#101820',flex:1},(!rooms.length||gwExporting)&&{opacity:.45}]}><Text style={styles.newMeasureText}>{gwExporting?'Enviando...':((project?.gwExportLastSentAtMs||0)>=(project?.updatedAt||0)&&project?.gwExportLastSentAtMs?'✓ Enviado ao GW':'GW Assistente')}</Text></Pressable></View></View></View>;
}

function ObjectModal({ visible, object, wallW, wallH, onClose, onSave, onDelete }) {
  const [w,setW]=useState('0,08'),[h,setH]=useState('0,08'),[left,setLeft]=useState('0,00'),[right,setRight]=useState('0,00'),[bottom,setBottom]=useState('0,00'),[top,setTop]=useState('0,00'),[depth,setDepth]=useState('0,15'),[thickness,setThickness]=useState('0,03'),[swing,setSwing]=useState('left'),[layer,setLayer]=useState(1),[diagramW,setDiagramW]=useState(Math.max(280,APP_W-44));
  const [voiceListening,setVoiceListening]=useState(false),[voiceText,setVoiceText]=useState(''),[voiceMessage,setVoiceMessage]=useState('');
  const diagramDragStart=useRef(0);
  const voiceSessionRef=useRef(false);
  const voiceOptions={lang:'pt-BR',interimResults:true,continuous:true,maxAlternatives:1,addsPunctuation:false};
  const isVoiceSaveCommand=t=>/(?:^|\s)(?:salvar|salva|confirmar|confirma)(?:\s+(?:medidas?|medição))?[.! ]*$/i.test(String(t||'').trim());
  const stripVoiceSaveCommand=t=>String(t||'').replace(/(?:^|\s)(?:salvar|salva|confirmar|confirma)(?:\s+(?:medidas?|medição))?[.! ]*$/i,'').trim();
  useEffect(()=>{if(object){
    const ow=Number(object.width||0),oh=Number(object.height||0),ol=Number(object.left||0),ob=Number(object.bottom||0);
    setW(numFmt(ow));setH(numFmt(oh));setLeft(numFmt(ol));setRight(numFmt(Math.max(0,wallW-ol-ow)));setBottom(numFmt(ob));setTop(numFmt(Math.max(0,wallH-ob-oh)));setDepth(numFmt(object.depth||.15));setThickness(numFmt(object.thickness||.03));setSwing(object.swing||'left');setLayer(visualLayer(object));
  }},[visible,object?.id,wallW,wallH]);
  useEffect(()=>()=>{voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}},[]);
  useSpeechRecognitionEvent('start',()=>{if(visible&&object){setVoiceListening(true);setVoiceMessage('Ouvindo… fale todas as medidas e diga “salvar” ou “confirmar” quando terminar.')}});
  useSpeechRecognitionEvent('end',()=>{if(!visible||!object)return;setVoiceListening(false);if(voiceSessionRef.current){setTimeout(()=>{if(voiceSessionRef.current&&visible){try{ExpoSpeechRecognitionModule.start(voiceOptions);}catch(_e){} }},180);}});
  useSpeechRecognitionEvent('result',event=>{if(!visible||!object)return;const t=(event.results||[]).map(r=>r?.transcript||'').filter(Boolean).join(' ').trim();if(!t)return;if(event.isFinal){const command=isVoiceSaveCommand(t),spoken=stripVoiceSaveCommand(t);setVoiceText(prev=>[prev,t].filter(Boolean).join(' · '));if(spoken)applyVoiceMeasures(spoken);if(command){const v=extractVoiceMeasures(spoken);const nw=clamp(v.width!=null?v.width:parseMeters(w,object.width),.02,wallW),nh=clamp(v.height!=null?v.height:parseMeters(h,object.height),.02,wallH),nl=clamp(v.left!=null?v.left:(v.right!=null?wallW-v.right-nw:parseMeters(left,object.left)),0,Math.max(0,wallW-nw)),nb=clamp(v.bottom!=null?v.bottom:(v.top!=null?wallH-v.top-nh:parseMeters(bottom,object.bottom)),0,Math.max(0,wallH-nh));voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}setVoiceListening(false);setVoiceMessage('Medidas confirmadas por voz. Salvando…');const saved={...object,width:nw,height:nh,left:nl,bottom:nb,depth:hasDepth?clamp(v.depth!=null?v.depth:parseMeters(depth,object.depth||.15),.01,5):object.depth,thickness:object.type==='Pia'?clamp(v.thickness!=null?v.thickness:parseMeters(thickness,object.thickness||.03),.005,.5):object.thickness,swing:object.type==='Porta'?swing:object.swing,layer};setTimeout(()=>{onSave(saved);onClose();},80);}}else setVoiceText(t);});
  useSpeechRecognitionEvent('error',event=>{if(!visible||!object)return;if(event.error==='aborted')return;if(event.error==='no-speech'&&voiceSessionRef.current)return;voiceSessionRef.current=false;setVoiceListening(false);setVoiceMessage('Não consegui ouvir. Toque no microfone e tente novamente.');});
  if(!object)return null;
  const hasDepth=isEquipment(object.type)||isStructure(object.type)||isReservedSpace(object.type)||['Rodapé','Sanca'].includes(object.type);
  const opening=isOpening(object.type),freeObject=isFreePlanType(object.type)||object.free===true;
  const setWidthSmart=v=>{setW(v);const width=parseMeters(v,object.width);const l=parseMeters(left,object.left);setRight(numFmt(Math.max(0,wallW-l-width)))};
  const setHeightSmart=v=>{setH(v);const height=parseMeters(v,object.height);const b=parseMeters(bottom,object.bottom);setTop(numFmt(Math.max(0,wallH-b-height)))};
  const setLeftSmart=v=>{setLeft(v);const l=parseMeters(v,object.left);const width=parseMeters(w,object.width);setRight(numFmt(Math.max(0,wallW-l-width)))};
  const setRightSmart=v=>{setRight(v);const r=parseMeters(v,0);const width=parseMeters(w,object.width);setLeft(numFmt(Math.max(0,wallW-r-width)))};
  const setBottomSmart=v=>{setBottom(v);const b=parseMeters(v,object.bottom);const height=parseMeters(h,object.height);setTop(numFmt(Math.max(0,wallH-b-height)))};
  const setTopSmart=v=>{setTop(v);const t=parseMeters(v,0);const height=parseMeters(h,object.height);setBottom(numFmt(Math.max(0,wallH-t-height)))};
  const applyVoiceMeasures=transcript=>{
    const values=extractVoiceMeasures(transcript),keys=Object.keys(values); if(!keys.length){setVoiceMessage('Não encontrei uma medida. Tente: “largura 90, altura 1 metro e 90”.');return;}
    if(values.width!=null)setWidthSmart(numFmt(values.width)); if(values.height!=null)setHeightSmart(numFmt(values.height)); if(values.depth!=null&&hasDepth)setDepth(numFmt(values.depth)); if(values.thickness!=null&&object.type==='Pia')setThickness(numFmt(values.thickness));
    if(values.left!=null&&!freeObject)setLeftSmart(numFmt(values.left)); if(values.right!=null&&!freeObject)setRightSmart(numFmt(values.right)); if(values.bottom!=null&&!freeObject)setBottomSmart(numFmt(values.bottom)); if(values.top!=null&&!freeObject)setTopSmart(numFmt(values.top));
    const names={width:'largura',height:'altura',depth:'profundidade',thickness:'espessura',left:'esquerda',right:'direita',bottom:'piso',top:'teto'};
    const used=keys.filter(k=>(k!=='depth'||hasDepth)&&(k!=='thickness'||object.type==='Pia')&&(!freeObject||!['left','right','bottom','top'].includes(k))); setVoiceMessage(`Preenchido: ${used.map(k=>names[k]).join(', ')}.`);
  };
  const toggleVoice=async()=>{try{if(voiceSessionRef.current||voiceListening){voiceSessionRef.current=false;ExpoSpeechRecognitionModule.stop();setVoiceListening(false);setVoiceMessage('Ditado concluído. Confira as medidas e toque em Salvar medidas.');return;}const permission=await ExpoSpeechRecognitionModule.requestPermissionsAsync();if(!permission.granted){Alert.alert('Microfone','Autorize Microfone e Reconhecimento de Fala para ditar as medidas.');return;}setVoiceText('');setVoiceMessage('');voiceSessionRef.current=true;ExpoSpeechRecognitionModule.start(voiceOptions);}catch(e){voiceSessionRef.current=false;console.warn('voice',e);Alert.alert('Voz',Platform.OS==='web'?'Não foi possível iniciar o reconhecimento de voz neste navegador. Use o Chrome.':'O reconhecimento de voz precisa do GW Medidas Development Build. Ele não funciona dentro do Expo Go.');}};
  const widthNow=clamp(parseMeters(w,object.width),.02,wallW),heightNow=clamp(parseMeters(h,object.height),.02,wallH),leftNow=clamp(parseMeters(left,object.left),0,Math.max(0,wallW-widthNow)),bottomNow=clamp(parseMeters(bottom,object.bottom),0,Math.max(0,wallH-heightNow));
  const rightNow=Math.max(0,wallW-leftNow-widthNow),topNow=Math.max(0,wallH-bottomNow-heightNow);
  const horizontalOk=Math.abs((leftNow+widthNow+rightNow)-wallW)<.011,verticalOk=Math.abs((bottomNow+heightNow+topNow)-wallH)<.011;
  const diagramTrackW=Math.max(120,diagramW-28);
  const diagramObjectW=clamp((widthNow/Math.max(.01,wallW))*diagramTrackW,44,Math.max(44,diagramTrackW));
  const diagramMaxLeft=Math.max(0,wallW-widthNow);
  const diagramLeftPx=14+(leftNow/Math.max(.01,wallW))*diagramTrackW;
  const dragDiagram=Gesture.Pan().minDistance(2).maxPointers(1).runOnJS(true)
    .onBegin(()=>{diagramDragStart.current=leftNow;})
    .onUpdate(e=>{
      const deltaM=(e.translationX/Math.max(1,diagramTrackW))*wallW;
      const next=clamp(diagramDragStart.current+deltaM,0,diagramMaxLeft);
      setLeft(numFmt(next));
      setRight(numFmt(Math.max(0,wallW-next-widthNow)));
    });
  const save=()=>{voiceSessionRef.current=false;try{ExpoSpeechRecognitionModule.stop();}catch(_e){}onSave({...object,width:widthNow,height:heightNow,left:leftNow,bottom:bottomNow,depth:hasDepth?clamp(parseMeters(depth,object.depth||.15),.01,5):object.depth,thickness:object.type==='Pia'?clamp(parseMeters(thickness,object.thickness||.03),.005,.5):object.thickness,swing:object.type==='Porta'?swing:object.swing,layer});onClose();};
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><KeyboardAvoidingView style={styles.sheetBackdrop} behavior={Platform.OS==='ios'?'padding':undefined} keyboardVerticalOffset={8}><Pressable style={{flex:1}} onPress={onClose}/><View style={[styles.sheet,styles.techEditSheet,{maxHeight:RAW_H*.88}]}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{paddingBottom:Platform.OS==='ios'?34:14}} showsVerticalScrollIndicator={false}><View style={styles.sheetHandle}/>
    <View style={styles.techEditHead}><ItemIcon type={object.type} size={46}/><View style={{flex:1}}><Text style={styles.techEditEyebrow}>EDIÇÃO TÉCNICA</Text><Text style={styles.techEditTitle}>{object.type}</Text><Text style={styles.formHint}>{freeObject?'Livre no ambiente · dimensões técnicas':`Parede ${String.fromCharCode(65+object.wall)} · ${mFmt(wallW)} × ${mFmt(wallH)}`}</Text></View>{onDelete?<Pressable onPress={onDelete} style={styles.deletePill}><Text style={styles.deletePillText}>Excluir</Text></Pressable>:null}</View>
    <View style={styles.techInfoStrip}><Text style={styles.techInfoTitle}>Medidas em metros</Text><Text style={styles.techInfoText}>Digite a medida real. As distâncias opostas são recalculadas para conferência.</Text></View>
    <View style={styles.voiceMeasureCard}><View style={{flex:1}}><Text style={styles.voiceMeasureTitle}>Preencher por voz</Text><Text style={styles.voiceMeasureHint}>{voiceListening?'Pode continuar falando… ao terminar diga “salvar” ou “confirmar”.':'Ex.: “largura 1,80, profundidade 60, do piso 90, salvar”'}</Text>{voiceText?<Text style={styles.voiceTranscript}>“{voiceText}”</Text>:null}{voiceMessage?<Text style={styles.voiceMessage}>{voiceMessage}</Text>:null}</View><Pressable onPress={toggleVoice} style={[styles.voiceMicBtn,voiceListening&&styles.voiceMicBtnOn]}><Text style={styles.voiceMicIcon}>{voiceListening?'■':'🎙️'}</Text><Text style={[styles.voiceMicText,voiceListening&&{color:WHITE}]}>{voiceListening?'Parar':'Falar'}</Text></Pressable></View>
    <Text style={styles.formSection}>Dimensões</Text><View style={styles.twoCols}><MiniField label="Largura" value={w} onChange={setWidthSmart}/><MiniField label="Altura" value={h} onChange={setHeightSmart}/>{hasDepth?<MiniField label="Profundidade" value={depth} onChange={setDepth}/>:null}{object.type==='Pia'?<MiniField label="Espessura" value={thickness} onChange={setThickness}/>:null}</View>
    <Text style={styles.formSection}>Camada visual</Text><View style={styles.swingRow}><Pressable onPress={()=>setLayer(0)} style={[styles.swingOption,layer<=0&&styles.swingOptionOn]}><Text style={[styles.swingOptionText,layer<=0&&styles.swingOptionTextOn]}>Enviar para trás</Text></Pressable><Pressable onPress={()=>setLayer(5)} style={[styles.swingOption,layer>0&&styles.swingOptionOn]}><Text style={[styles.swingOptionText,layer>0&&styles.swingOptionTextOn]}>Trazer para frente</Text></Pressable></View>
    {object.type==='Porta'?<><Text style={styles.formSection}>Sentido de abertura</Text><Text style={styles.formHint}>A folha abre para dentro do ambiente.</Text><View style={styles.swingRow}><Pressable onPress={()=>setSwing('left')} style={[styles.swingOption,swing==='left'&&styles.swingOptionOn]}><Text style={[styles.swingOptionText,swing==='left'&&styles.swingOptionTextOn]}>↙ Esquerda</Text></Pressable><Pressable onPress={()=>setSwing('right')} style={[styles.swingOption,swing==='right'&&styles.swingOptionOn]}><Text style={[styles.swingOptionText,swing==='right'&&styles.swingOptionTextOn]}>Direita ↘</Text></Pressable></View></>:null}
    {!freeObject?<><Text style={styles.formSection}>Posição na parede</Text><Text style={styles.measureDragHint}>Arraste o item para fazer o ajuste fino ou digite a medida abaixo.</Text><View style={styles.measureDiagram} onLayout={e=>setDiagramW(e.nativeEvent.layout.width)}><View style={styles.measureWallLine}/><GestureDetector gesture={dragDiagram}><View style={[styles.measureObject,{left:diagramLeftPx,width:diagramObjectW}]}><Text style={styles.measureObjectText}>{object.type}</Text><Text style={styles.measureObjectGrip}>↔</Text></View></GestureDetector><Text style={styles.measureDiagramLeft}>← {mFmt(leftNow)}</Text><Text style={styles.measureDiagramRight}>{mFmt(rightNow)} →</Text></View>
    <View style={styles.twoCols}><MiniField label="Esquerda" value={left} onChange={setLeftSmart}/><MiniField label="Direita" value={right} onChange={setRightSmart}/><MiniField label="Do piso" value={bottom} onChange={setBottomSmart}/><MiniField label="Do teto" value={top} onChange={setTopSmart}/></View>
    <View style={styles.checkCard}><View style={styles.checkRow}><Text style={styles.checkLabel}>Conferência horizontal</Text><Text style={[styles.checkValue,horizontalOk&&styles.checkValueOk]}>{horizontalOk?'✓ Fecha':'Revisar'}</Text></View><Text style={styles.checkFormula}>{mFmt(leftNow)} + {mFmt(widthNow)} + {mFmt(rightNow)} = {mFmt(wallW)}</Text><View style={[styles.checkRow,{marginTop:8}]}><Text style={styles.checkLabel}>Conferência vertical</Text><Text style={[styles.checkValue,verticalOk&&styles.checkValueOk]}>{verticalOk?'✓ Fecha':'Revisar'}</Text></View><Text style={styles.checkFormula}>{mFmt(bottomNow)} + {mFmt(heightNow)} + {mFmt(topNow)} = {mFmt(wallH)}</Text></View>
    {opening?<Text style={styles.techFootHint}>Para aberturas, confira principalmente largura, altura, piso/teto e afastamentos laterais antes de salvar.</Text>:null}</>:<Text style={styles.techFootHint}>Este item é livre na planta. Ajuste largura, altura e profundidade aqui; a posição é definida arrastando o objeto diretamente na Planta.</Text>}
    <Pressable onPress={save} style={styles.techSaveBtn}><Text style={styles.techSaveBtnText}>✓ Salvar medidas</Text></Pressable>
  </ScrollView></View></KeyboardAvoidingView></Modal>;
}
function MiniField({label,value,onChange}){return <View style={styles.miniField}><Text style={styles.miniLabel}>{label}</Text><View style={styles.miniInputWrap}><TextInput keyboardType="decimal-pad" selectTextOnFocus style={styles.miniInputTech} value={value} onChangeText={onChange}/><Text style={styles.miniUnit}>m</Text></View></View>}

function Elevation({ project, room, wallIndex, onBack, onUpdateRoom }) {
  const wallW=room.lengths[wallIndex]||3.2, wallH=room.height||2.65, boardW=APP_W-24, boardH=Math.min(500,RAW_H*.56); const px=Math.min((boardW-54)/wallW,(boardH-72)/wallH);
  const [selectedId,setSelectedId]=useState(null),[editOpen,setEditOpen]=useState(false),[addOpen,setAddOpen]=useState(false); const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0}); const pinchStart=useRef(1),panStart=useRef({x:0,y:0});
  const objects=(room.elements||[]).filter(e=>elementWallIndex(e,room)===wallIndex).map(e=>isInternalWall(e.type)?frontObjectForRoom(e,wallIndex,room):constrainElementToWallSegments(room,e)), selected=objects.find(e=>e.id===selectedId);
  const updateObj=o=>{
    const original=(room.elements||[]).find(x=>x.id===o.id);
    // A parede interna é posicionada na Planta. Na vista frontal ela é apenas uma
    // projeção técnica do ponto de encontro, evitando que um arraste frontal
    // altere a geometria validada da Planta.
    const next=isInternalWall(original?.type)?original:constrainElementToWallSegments(room,o);
    onUpdateRoom({...room,elements:(room.elements||[]).map(x=>x.id===o.id?next:x)},false);
  };
  const addElement=type=>{const d=DEFAULTS[type]||{width:.2,height:.2,bottom:0};const raw={id:uid(),type,wall:wallIndex,width:d.width,height:d.height,bottom:d.bottom,depth:d.depth||.15,thickness:d.thickness,left:clamp((wallW-d.width)/2,0,wallW)};const o=constrainElementToWallSegments(room,raw);onUpdateRoom({...room,elements:[...(room.elements||[]),o]},false);setSelectedId(o.id);setAddOpen(false)};
  const pinch=Gesture.Pinch().runOnJS(true).onBegin(()=>pinchStart.current=zoom).onUpdate(e=>setZoom(clamp(pinchStart.current*e.scale,.8,3.4)));const pan=Gesture.Pan().minPointers(2).runOnJS(true).onBegin(()=>panStart.current=offset).onUpdate(e=>setOffset({x:panStart.current.x+e.translationX,y:panStart.current.y+e.translationY}));const gesture=Gesture.Simultaneous(pinch,pan);
  return <View style={styles.editorScreen}><View style={styles.editorTop}><Pressable onPress={onBack}><Text style={styles.back}>‹ Planta</Text></Pressable><View style={{flex:1,marginHorizontal:10}}><Text style={styles.editorTitle}>Parede {String.fromCharCode(65+wallIndex)}</Text><Text style={styles.editorSub}>{mFmt(wallW)} × {mFmt(wallH)} · {room.name}</Text></View><Pressable onPress={()=>onUpdateRoom(room,true)} style={styles.saveBtn}><Text style={styles.saveBtnText}>Salvar</Text></Pressable></View><View style={styles.toolBar}><Text style={styles.toolLabel}>Arraste para pré-posicionar · toque para editar com precisão</Text><Text style={styles.zoomBadge}>{Math.round(zoom*100)}%</Text></View><GestureDetector gesture={gesture}><View style={[styles.elevCanvas,{width:boardW,height:boardH}]}><View style={{flex:1,transform:[{translateX:offset.x},{translateY:offset.y},{scale:zoom}]}}><View style={[styles.wallFace,{left:27,top:28,width:wallW*px,height:wallH*px}]}/><View pointerEvents="none" style={[styles.wallWidthCota,{left:27,top:4,width:wallW*px}]}><Text style={styles.wallCotaText}>{mFmt(wallW)}</Text></View><View pointerEvents="none" style={[styles.wallHeightCota,{left:31+wallW*px,top:28,height:wallH*px}]}><Text style={[styles.wallCotaText,{transform:[{rotate:'90deg'}]}]}>{mFmt(wallH)}</Text></View>{objects.map(o=><WallObject key={o.id} obj={o} wallW={wallW} wallH={wallH} boardW={boardW} boardH={boardH} px={px} selected={o.id===selectedId} onSelect={()=>setSelectedId(o.id)} onEdit={()=>{setSelectedId(o.id);setEditOpen(true)}} onChange={updateObj}/>)}</View></View></GestureDetector>{selected?<View style={styles.cotaBar}><Text style={styles.cotaText}>← {mFmt(isInternalWall(selected.type)?selected.left:Math.max(0,selected.left-wallSegmentForElement(room,selected).start))}</Text><Text style={styles.cotaName}>{selected.type}</Text><Text style={styles.cotaText}>{mFmt(isInternalWall(selected.type)?Math.max(0,wallW-selected.left-selected.width):Math.max(0,wallSegmentForElement(room,selected).end-selected.left-selected.width))} →</Text><Text style={styles.cotaText}>↕ piso {mFmt(selected.bottom)}</Text></View>:<Text style={styles.selectHint}>Selecione um elemento para ver as cotas.</Text>}<View style={styles.elevActions}><Button secondary title="＋ Adicionar" onPress={()=>setAddOpen(true)}/>{selected?<Button title="Editar" onPress={()=>setEditOpen(true)}/>:null}</View><AddSheet visible={addOpen} allowedGroups={FRONT_GROUPS} excludedItems={FREE_PLAN_TYPES} initialGroup="Pontos" onClose={()=>setAddOpen(false)} onAdd={addElement} wallIndex={wallIndex}/><ObjectModal visible={editOpen} object={selected} wallW={wallW} wallH={wallH} onClose={()=>setEditOpen(false)} onSave={updateObj} onDelete={()=>{if(!selected)return;confirmDelete('Excluir item','Remover este item da medição?',()=>{onUpdateRoom({...room,elements:(room.elements||[]).filter(e=>e.id!==selected.id)},false);setSelectedId(null);setEditOpen(false)});}}/></View>;
}

function ElementVisual({type,width,height}){
  const line='#4E565C', light='#F7F7F5', wood='#B98A59', blueGlass='#C7E8F3';
  const svg=(children)=><Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">{children}</Svg>;
  if(type==='Porta') return svg(<><Defs><LinearGradient id="doorG" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#D0A777"/><Stop offset="1" stopColor={wood}/></LinearGradient></Defs><Rect x="3" y="2" width="94" height="98" fill="#6D5137"/><Rect x="8" y="5" width="84" height="95" fill="url(#doorG)" stroke="#59422F" strokeWidth="2"/><Rect x="17" y="15" width="66" height="30" fill="none" stroke="#8C6845" strokeWidth="2"/><Rect x="17" y="54" width="66" height="34" fill="none" stroke="#8C6845" strokeWidth="2"/><Circle cx="80" cy="51" r="3" fill="#31363A"/></>);
  if(type==='Janela') return svg(<><Rect x="3" y="4" width="94" height="92" fill="#67747C"/><Rect x="9" y="10" width="82" height="80" fill={blueGlass} stroke="#4D606A" strokeWidth="2"/><Line x1="50" y1="10" x2="50" y2="90" stroke="#5D7079" strokeWidth="3"/><Line x1="9" y1="50" x2="91" y2="50" stroke="#6D8089" strokeWidth="2"/><Rect x="5" y="89" width="90" height="7" fill="#AEB7BC"/></>);
  if(type==='Passagem') return svg(<><Rect x="2" y="2" width="96" height="96" rx="3" fill="#101820"/><SvgText x="50" y="52" textAnchor="middle" fontSize="4" fontWeight="700" fill="#FFFFFF">PASSAGEM</SvgText></>);
  if(type==='Pia') return svg(<><Defs><LinearGradient id="sinkFront" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#F3F4F4"/><Stop offset="1" stopColor="#B8C0C4"/></LinearGradient></Defs><Rect x="2" y="36" width="96" height="28" rx="2" fill="url(#sinkFront)" stroke={line} strokeWidth="2"/><Rect x="2" y="60" width="96" height="8" fill="#8E979C"/><Line x1="5" y1="39" x2="95" y2="39" stroke="#FFFFFF" strokeWidth="2" opacity=".8"/></>);
  if(type==='Geladeira') return svg(<><Defs><LinearGradient id="fridgeG" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#FAFBFC"/><Stop offset="1" stopColor="#C8CED2"/></LinearGradient></Defs><Rect x="5" y="2" width="90" height="96" rx="5" fill="url(#fridgeG)" stroke="#5A6268" strokeWidth="2"/><Line x1="5" y1="38" x2="95" y2="38" stroke="#7D868C" strokeWidth="2"/><Line x1="80" y1="11" x2="80" y2="31" stroke="#626B71" strokeWidth="3"/><Line x1="80" y1="47" x2="80" y2="70" stroke="#626B71" strokeWidth="3"/></>);
  if(type==='Fogão') return svg(<><Rect x="4" y="3" width="92" height="94" rx="3" fill="#5C646A" stroke="#22282C" strokeWidth="2"/><Rect x="8" y="7" width="84" height="20" fill="#32383D"/>{[20,40,60,80].map(x=><Circle key={x} cx={x} cy="17" r="6" fill="#111719" stroke="#8D969A" strokeWidth="1"/>)}<Rect x="13" y="38" width="74" height="44" rx="3" fill="#20262A" stroke="#9AA1A5" strokeWidth="2"/><Rect x="20" y="45" width="60" height="28" fill="#56636B"/><Line x1="17" y1="31" x2="83" y2="31" stroke="#C1C6C8" strokeWidth="2"/></>);
  if(type==='Cooktop') return svg(<><Rect x="2" y="25" width="96" height="50" rx="4" fill="#30363A" stroke="#161B1E" strokeWidth="2"/>{[[25,40],[50,40],[75,40],[25,62],[50,62],[75,62]].map((p,i)=><Circle key={i} cx={p[0]} cy={p[1]} r="7" fill="#111719" stroke="#A4AAAD" strokeWidth="1.5"/>)}</>);
  if(type==='Forno'||type==='Micro-ondas') return svg(<><Rect x="4" y="5" width="92" height="90" rx="3" fill="#4A5156" stroke="#23282C" strokeWidth="2"/><Rect x="13" y="24" width="65" height="52" fill="#1F2529" stroke="#899298" strokeWidth="2"/><Rect x="18" y="30" width="55" height="40" fill="#52616A"/><Circle cx="86" cy="27" r="4" fill="#C2C8CA"/><Circle cx="86" cy="42" r="4" fill="#C2C8CA"/></>);
  if(type==='Máquina de lavar') return svg(<><Rect x="4" y="3" width="92" height="94" rx="5" fill="#E9ECEE" stroke="#59656C" strokeWidth="2"/><Rect x="10" y="9" width="80" height="15" fill="#D4D9DC"/><Circle cx="50" cy="60" r="27" fill="#9EB5C0" stroke="#5B6A72" strokeWidth="3"/><Circle cx="50" cy="60" r="19" fill="#C6DBE3" stroke="#7A8C94" strokeWidth="2"/></>);
  if(type==='Lava-louças') return svg(<><Rect x="4" y="3" width="92" height="94" rx="3" fill="#E8EBED" stroke="#5B656B" strokeWidth="2"/><Rect x="9" y="9" width="82" height="12" fill="#C9D0D4"/><Line x1="14" y1="29" x2="86" y2="29" stroke="#7B858B" strokeWidth="2"/><Rect x="15" y="39" width="70" height="45" fill="#D7DCDF" stroke="#879096" strokeWidth="1"/></>);
  if(type==='Tanque') return svg(<><Rect x="4" y="22" width="92" height="60" fill="#D7DBDC" stroke="#626D72" strokeWidth="2"/><Path d="M 15 32 Q 50 20 85 32 L 79 67 Q 50 77 21 67 Z" fill="#EDF0F1" stroke="#707A7F" strokeWidth="2"/><Path d="M 51 22 L 51 10 Q 51 5 61 5 L 68 5" fill="none" stroke="#5C676C" strokeWidth="4"/></>);
  if(type==='Coifa') return svg(<><Path d="M 16 70 L 30 30 L 70 30 L 84 70 Z" fill="#C9CED1" stroke="#616A70" strokeWidth="2"/><Rect x="42" y="2" width="16" height="30" fill="#AEB5B9" stroke="#626B70" strokeWidth="2"/><Rect x="10" y="70" width="80" height="12" fill="#90989C"/></>);
  if(type==='Cama solteiro'||type==='Cama casal') return svg(<><Rect x="4" y="32" width="92" height="48" rx="5" fill="#E8E2D8" stroke="#756B61" strokeWidth="2"/><Rect x="7" y="21" width="86" height="16" rx="4" fill="#C9BAA7" stroke="#756B61" strokeWidth="2"/><Rect x="18" y="38" width="28" height="13" rx="5" fill="#FAF8F4" stroke="#A89C8D"/><Rect x="54" y="38" width="28" height="13" rx="5" fill="#FAF8F4" stroke="#A89C8D"/></>);
  if(type==='Beliche') return svg(<><Rect x="8" y="12" width="84" height="28" rx="3" fill="#E8E2D8" stroke="#756B61" strokeWidth="3"/><Rect x="8" y="62" width="84" height="28" rx="3" fill="#E8E2D8" stroke="#756B61" strokeWidth="3"/><Line x1="14" y1="8" x2="14" y2="96" stroke="#675B50" strokeWidth="4"/><Line x1="86" y1="8" x2="86" y2="96" stroke="#675B50" strokeWidth="4"/><Line x1="72" y1="42" x2="72" y2="60" stroke="#675B50" strokeWidth="3"/></>);
  if(type==='Televisão') return svg(<><Rect x="4" y="10" width="92" height="68" rx="4" fill="#25313A" stroke="#111820" strokeWidth="3"/><Rect x="9" y="15" width="82" height="58" fill="#607887"/><Line x1="50" y1="78" x2="50" y2="90" stroke="#303940" strokeWidth="4"/><Line x1="36" y1="90" x2="64" y2="90" stroke="#303940" strokeWidth="4"/></>);
  if(type==='Mesa') return svg(<><Rect x="8" y="18" width="84" height="36" rx="4" fill="#CEB38F" stroke="#725B43" strokeWidth="3"/><Line x1="18" y1="54" x2="13" y2="94" stroke="#725B43" strokeWidth="5"/><Line x1="82" y1="54" x2="87" y2="94" stroke="#725B43" strokeWidth="5"/></>);
  if(type==='Tomada') return svg(<><Rect x="13" y="18" width="74" height="64" rx="13" fill="#FBFCFD" stroke="#46515A" strokeWidth="5"/><Circle cx="36" cy="48" r="6" fill="#46515A"/><Circle cx="64" cy="48" r="6" fill="#46515A"/><Path d="M 50 58 L 43 70 L 57 70 Z" fill="#46515A"/></>);
  if(type==='Interruptor') return svg(<><Rect x="17" y="12" width="66" height="76" rx="10" fill="#FBFCFD" stroke="#46515A" strokeWidth="5"/><Rect x="31" y="24" width="38" height="52" rx="7" fill="#E8EDF0" stroke="#6A757D" strokeWidth="3"/><Line x1="34" y1="50" x2="66" y2="50" stroke="#6A757D" strokeWidth="3"/></>);
  if(type==='Água') return svg(<><Circle cx="50" cy="55" r="22" fill="#E9F6FC" stroke="#39738C" strokeWidth="5"/><Path d="M 50 10 C 37 29 30 39 30 52 C 30 66 39 76 50 76 C 61 76 70 66 70 52 C 70 39 63 29 50 10 Z" fill="#BDE8F8" stroke="#39738C" strokeWidth="3"/></>);
  if(type==='Esgoto') return svg(<><Circle cx="50" cy="50" r="32" fill="#F5F7F8" stroke="#4B565E" strokeWidth="5"/><Circle cx="50" cy="50" r="17" fill="none" stroke="#77828A" strokeWidth="4"/><Line x1="30" y1="50" x2="70" y2="50" stroke="#77828A" strokeWidth="3"/><Line x1="50" y1="30" x2="50" y2="70" stroke="#77828A" strokeWidth="3"/></>);
  if(type==='Gás') return svg(<><Circle cx="50" cy="50" r="31" fill="#FFF8E7" stroke="#75602D" strokeWidth="5"/><Path d="M 52 18 C 65 34 69 42 66 55 C 63 68 55 77 43 76 C 31 75 25 66 27 55 C 29 44 39 39 42 29 C 44 23 43 18 43 18 C 47 20 50 23 52 27 C 54 24 54 21 52 18 Z" fill="#E6C15D" stroke="#75602D" strokeWidth="2"/></>);
  if(type==='TV/Dados') return svg(<><Rect x="12" y="20" width="76" height="60" rx="9" fill="#FBFCFD" stroke="#46515A" strokeWidth="5"/><Rect x="27" y="34" width="46" height="28" rx="3" fill="#DDE6EB" stroke="#6C7880" strokeWidth="3"/><Line x1="42" y1="70" x2="58" y2="70" stroke="#46515A" strokeWidth="4"/></>);
  if(isPoint(type)) return svg(<><Circle cx="50" cy="50" r="32" fill="#FBFCFD" stroke="#515C64" strokeWidth="5"/><Circle cx="50" cy="50" r="7" fill="#515C64"/></>);
  if(isStructure(type)) return svg(<><Defs><LinearGradient id="structG" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor="#D5DADD"/><Stop offset="1" stopColor="#9FA8AE"/></LinearGradient></Defs><Rect x="4" y="3" width="92" height="94" fill="url(#structG)" stroke="#626B71" strokeWidth="2"/>{[18,35,52,69,86].map(y=><Line key={y} x1="8" y1={y} x2="92" y2={y-10} stroke="#B8C0C4" strokeWidth="1"/>)}</>);
  return svg(<><Rect x="4" y="4" width="92" height="92" fill={light} stroke={line} strokeWidth="2"/><Line x1="12" y1="50" x2="88" y2="50" stroke="#A7B0B5" strokeWidth="2"/></>);
}

function WallObject({obj,wallW,wallH,boardW,boardH,px,selected,onSelect,onEdit,onChange,pinchingRef}){
  const opening=isOpening(obj.type), equip=isEquipment(obj.type), structure=isStructure(obj.type), reserved=isReservedSpace(obj.type), point=isPoint(obj.type), finish=groupOf(obj.type)==='Acabamentos';
  const naturalW=Math.max(3,obj.width*px), naturalH=Math.max(3,obj.height*px);
  const vw=point?26:Math.max(naturalW,opening?26:equip?18:structure?10:finish?8:16);
  const vh=point?26:obj.type==='Rodapé'?Math.max(naturalH,6):obj.type==='Sanca'?Math.max(naturalH,7):obj.type==='Pia'?Math.max(naturalH,9):obj.type==='Cooktop'?Math.max(naturalH,6):Math.max(naturalH,opening?26:equip?18:structure?10:10);
  const x=27+obj.left*px,y=46+(wallH-obj.bottom-obj.height)*px;const start=useRef({left:obj.left,bottom:obj.bottom});
  const pan=Gesture.Pan().minDistance(7).activateAfterLongPress(70).maxPointers(1).runOnJS(true).onBegin(()=>{start.current={left:obj.left,bottom:obj.bottom};}).onUpdate(e=>{if(pinchingRef?.current)return;onChange({...obj,left:clamp(start.current.left+e.translationX/px,0,Math.max(0,wallW-obj.width)),bottom:clamp(start.current.bottom-e.translationY/px,0,Math.max(0,wallH-obj.height))})});
  const tap=Gesture.Tap().maxDistance(8).runOnJS(true).onEnd((_e,ok)=>{if(ok)onSelect()});
  const objectGesture=selected?Gesture.Exclusive(pan,tap):tap;
  // Área de toque compacta: acompanha o desenho real do item. Antes ela avançava
  // dezenas de pixels para fora do objeto e acabava cobrindo o piso/área vazia,
  // impedindo o toque de chegar ao canvas para desselecionar e congelar a tela.
  const hitPad=10;
  const visualStyle=[styles.objVisual,{width:vw,height:vh,position:'absolute',left:hitPad,top:hitPad},opening&&styles.objOpening,equip&&styles.objEquip,structure&&styles.objStructure,point&&styles.objPoint,reserved&&{borderStyle:'dashed',backgroundColor:'rgba(255,255,255,.55)'},selected&&styles.objSelected];
  return <GestureDetector gesture={objectGesture}><View style={[styles.objTouch,{left:x-hitPad,top:y-hitPad,width:vw+hitPad*2,height:vh+hitPad*2,zIndex:visualLayer(obj)}]}>
    <View style={visualStyle}><ElementVisual type={obj.type} width={vw} height={vh}/></View>
    {selected?<View pointerEvents="none" style={[styles.techDimLine,{left:hitPad,top:hitPad+vh+8,width:Math.max(vw,48)}]}><View style={styles.techDimTick}/><Text style={styles.techDimText}>{numFmt(obj.width)} m</Text><View style={styles.techDimTick}/></View>:null}
    {selected?<>
      <View pointerEvents="none" style={{position:'absolute',left:hitPad+vw+8,top:hitPad,height:vh,minHeight:30,width:24,alignItems:'center',justifyContent:'center'}}><View style={{position:'absolute',left:6,top:0,bottom:0,width:1,backgroundColor:BLUE}}/><View style={{position:'absolute',left:2,top:0,width:9,height:1,backgroundColor:BLUE}}/><View style={{position:'absolute',left:2,bottom:0,width:9,height:1,backgroundColor:BLUE}}/><Text style={{fontSize:7.4,fontWeight:'900',color:BLUE,backgroundColor:'#FFF',paddingHorizontal:2,transform:[{rotate:'90deg'}]}}>{numFmt(obj.height)}</Text></View>
      <View pointerEvents="none" style={[styles.selectedPosTag,{top:1,right:1}]}><Text style={styles.selectedPosText}>↔ esq. {numFmt(obj.left)} · ↑ piso {numFmt(obj.bottom)}</Text></View>
    </>:null}
  </View></GestureDetector>;
}

function ProjectScreen({ project, onBack, onOpenRoom, onNewRoom, onDeleteRoom, onDeleteProject, onExportProject, onSendToGw, onLinkToGw, gwSending, gwLinking }) {
  if(!project) return <View style={styles.screen}/>;
  const isGwBudget=project.gwSourceType==='orcamento';
  const isGwProject=project.gwSourceType==='projeto';
  const hasRooms=(project.rooms||[]).length>0;
  const cardTitle=isGwBudget?'Orçamento do GW Assistente':isGwProject?'Projeto aprovado no GW Assistente':'Medição local';
  const cardText=isGwBudget?(hasRooms?'As medidas feitas aqui serão enviadas para este orçamento.':'Crie um ambiente e faça o levantamento. Depois o envio para este orçamento será liberado.'):isGwProject?'Continue medindo normalmente. Quando houver alterações, atualize o levantamento deste projeto no GW Assistente.':'Esta medição ainda não tem destino no GW Assistente. Vincule-a a um orçamento ou projeto existente.';
  const actionLabel=isGwBudget?(hasRooms?'↑ Enviar levantamento ao orçamento':'Crie um ambiente para enviar'):isGwProject?'↑ Atualizar levantamento no projeto':'↔ Vincular ao GW Assistente';
  const disabled=gwSending||gwLinking||((isGwBudget||isGwProject)&&!hasRooms);
  return <View style={styles.screen}><Header title={project.name} subtitle={`${project.client}${isGwBudget?' · Orçamento GW':isGwProject?' · Projeto aprovado':' · Medição local'}`} onBack={onBack} right={<Pressable onPress={onDeleteProject} style={styles.deleteHeaderBtn}><Text style={styles.deleteHeaderText}>Excluir</Text></Pressable>}/><ScrollView style={{flex:1}} contentContainerStyle={styles.projectList}><View style={styles.gwSendCard}><View style={{flex:1}}><Text style={styles.gwSendTitle}>{cardTitle}</Text><Text style={styles.gwSendText}>{cardText}</Text>{project.gwLastPushAt?<Text style={styles.gwSendLast}>Último envio: {new Date(project.gwLastPushAt).toLocaleString('pt-BR')}</Text>:null}</View><Pressable disabled={disabled} onPress={isGwBudget||isGwProject?onSendToGw:onLinkToGw} style={[styles.gwSendBtn,disabled&&{opacity:.45}]}><Text style={styles.gwSendBtnText}>{gwSending?'Enviando...':gwLinking?'Carregando...':actionLabel}</Text></Pressable></View><Text style={styles.sectionKicker}>AMBIENTES</Text>{project.rooms.map(r=><View key={r.id} style={styles.roomCardCompact}><Pressable onPress={()=>onOpenRoom(r.id)} style={styles.projectOpenArea}><View style={styles.roomBadgeSmall}><Text>⌗</Text></View><View style={{flex:1}}><Text style={styles.roomTitleSmall}>{r.name}</Text><Text style={styles.roomMeta}>{r.wallCount} parede{r.wallCount!==1?'s':''} · {(r.elements||[]).length} itens · {(r.photos||[]).length} fotos</Text></View><Text style={styles.chevSmall}>›</Text></Pressable><Pressable onPress={()=>onDeleteRoom(r.id)} style={styles.deleteIconBtn}><Text style={styles.deleteIconText}>🗑</Text></Pressable></View>)}</ScrollView><View style={styles.homeFooter}><View style={{flexDirection:'row',gap:10}}><Pressable onPress={onExportProject} style={[styles.newMeasureBtn,{flex:1,backgroundColor:'#101820'}]}><Text style={styles.newMeasureText}>⇧ Exportar projeto</Text></Pressable><Pressable onPress={onNewRoom} style={[styles.newMeasureBtn,{flex:1}]}><Text style={styles.newMeasureText}>＋ Ambiente</Text></Pressable></View></View></View>;
}

function RoomHub({project,room,onBack,onPlan,onPhotos,onSave}) {
  return <ScrollView style={styles.screen}><Header title={room.name} subtitle={`${project.client} · ${project.name}`} onBack={onBack} right={<Pressable onPress={()=>onSave(room,true)} style={styles.saveBtn}><Text style={styles.saveBtnText}>Salvar</Text></Pressable>}/><View style={styles.pad}><Pressable style={styles.hubCard} onPress={onPlan}><View style={styles.hubIcon}><Text style={{fontSize:25}}>⌗</Text></View><View style={{flex:1}}><Text style={styles.hubTitle}>Planta e paredes</Text><Text style={styles.hubText}>{room.wallCount} parede{room.wallCount!==1?'s':''} · toque para medir e detalhar</Text></View><Text style={styles.chev}>›</Text></Pressable><Pressable style={styles.hubCard} onPress={onPhotos}><View style={styles.hubIcon}><Text style={{fontSize:25}}>📷</Text></View><View style={{flex:1}}><Text style={styles.hubTitle}>Fotos</Text><Text style={styles.hubText}>{(room.photos||[]).length} foto{(room.photos||[]).length!==1?'s':''} · câmera ou galeria</Text></View><Text style={styles.chev}>›</Text></Pressable><View style={styles.summaryBox}><Text style={styles.sectionKicker}>RESUMO DO AMBIENTE</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>GROUPS.find(g=>g.key==='Aberturas').items.includes(e.type)).length} aberturas</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>GROUPS.find(g=>g.key==='Pontos').items.includes(e.type)).length} pontos</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>GROUPS.find(g=>g.key==='Estruturas').items.includes(e.type)).length} estruturas</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>isReservedSpace(e.type)).length} vãos reservados</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>isEquipment(e.type)).length} equipamentos</Text><Text style={styles.summaryLine}>{(room.elements||[]).filter(e=>GROUPS.find(g=>g.key==='Acabamentos').items.includes(e.type)).length} acabamentos</Text></View></View></ScrollView>;
}

function Photos({room,onBack,onUpdateRoom}){
  const take=async()=>{const perm=await ImagePicker.requestCameraPermissionsAsync();if(!perm.granted){Alert.alert('Câmera','Autorize o acesso à câmera para tirar fotos da obra.');return;}const r=await ImagePicker.launchCameraAsync({mediaTypes:['images'],quality:.8,base64:true});if(!r.canceled){onUpdateRoom({...room,photos:[...(room.photos||[]),{id:uid(),uri:r.assets[0].uri,dataUri:r.assets[0].base64?`data:${r.assets[0].mimeType||'image/jpeg'};base64,${r.assets[0].base64}`:null,source:'camera'}]},false)}};
  const gallery=async()=>{const r=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],quality:.8,base64:true});if(!r.canceled){onUpdateRoom({...room,photos:[...(room.photos||[]),{id:uid(),uri:r.assets[0].uri,dataUri:r.assets[0].base64?`data:${r.assets[0].mimeType||'image/jpeg'};base64,${r.assets[0].base64}`:null,source:'gallery'}]},false)}};
  return <ScrollView style={styles.screen}><Header title="Fotos" subtitle={room.name} onBack={onBack}/><View style={styles.pad}><Button title="📷 Tirar foto" onPress={take}/><Button secondary title="Escolher da galeria" onPress={gallery}/><View style={styles.photoGrid}>{(room.photos||[]).map(p=><View key={p.id} style={styles.photoCard}><Image source={{uri:p.uri}} style={styles.photo}/><Pressable style={styles.photoDelete} onPress={()=>onUpdateRoom({...room,photos:room.photos.filter(x=>x.id!==p.id)},false)}><Text>✕</Text></Pressable></View>)}</View>{!(room.photos||[]).length?<View style={styles.emptyPhotos}><Text style={styles.emptyHomeIcon}>📷</Text><Text style={styles.emptyHomeTitle}>Nenhuma foto ainda</Text><Text style={styles.emptyHomeText}>Use “Tirar foto” para abrir a câmera direto na obra.</Text></View>:null}</View></ScrollView>
}

const htmlSafe=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const groupOf=type=>GROUPS.find(g=>g.items.includes(type))?.key||'Outro';
const reportPlanSvg=room=>{
  const W=560,H=390,ls=room.lengths||[],count=room.wallCount||1;
  const max=Math.max(...ls,1),scale=Math.min(92,430/max),cx=W/2,cy=H/2;
  let walls=[];
  if(count===1){const y=cy,x0=cx-(ls[0]*scale)/2;walls=[[[x0,y],[x0+ls[0]*scale,y]]];}
  else if(count===2){const x0=cx-(ls[0]*scale)/2,y0=92,x1=x0+ls[0]*scale;walls=[[[x0,y0],[x1,y0]],[[x1,y0],[x1,y0+ls[1]*scale]]];}
  else if(count===3){const x0=cx-(ls[0]*scale)/2,y0=86,x1=x0+ls[0]*scale;walls=[[[x0,y0],[x1,y0]],[[x1,y0],[x1,y0+ls[1]*scale]],[[x0,y0+ls[2]*scale],[x0,y0]]];}
  else {const x0=cx-(ls[0]*scale)/2,y0=78,x1=x0+ls[0]*scale,y1=y0+ls[1]*scale;walls=[[[x0,y0],[x1,y0]],[[x1,y0],[x1,y1]],[[x1,y1],[x0,y1]],[[x0,y1],[x0,y0]]];}
  const center=walls.flat().reduce((a,p)=>[a[0]+p[0],a[1]+p[1]],[0,0]).map(v=>v/Math.max(1,walls.flat().length));
  const inward=(a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],L=Math.hypot(dx,dy)||1,n1=[-dy/L,dx/L],mid=[(a[0]+b[0])/2,(a[1]+b[1])/2],d1=(mid[0]+n1[0]*20-center[0])**2+(mid[1]+n1[1]*20-center[1])**2,d2=(mid[0]-n1[0]*20-center[0])**2+(mid[1]-n1[1]*20-center[1])**2;return d1<d2?n1:[-n1[0],-n1[1]]};
  const dimLine=(a,b,i)=>{const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)||1,iv=inward(a,b),nx=-iv[0],ny=-iv[1],off=24,ax=a[0]+nx*off,ay=a[1]+ny*off,bx=b[0]+nx*off,by=b[1]+ny*off,mx=(ax+bx)/2,my=(ay+by)/2;return `<line x1="${a[0]}" y1="${a[1]}" x2="${ax}" y2="${ay}" stroke="#9aa8b5" stroke-width=".7"/><line x1="${b[0]}" y1="${b[1]}" x2="${bx}" y2="${by}" stroke="#9aa8b5" stroke-width=".7"/><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#485968" stroke-width="1"/><rect x="${mx-28}" y="${my-9}" width="56" height="16" rx="5" fill="#fff" stroke="#e2e8ee"/><text x="${mx}" y="${my+2}" font-size="9" font-weight="700" text-anchor="middle" fill="#46515c">${numFmt(ls[i])} m</text>`};
  const wallLines=walls.map((w,i)=>{const [a,b]=w;return `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#20262D" stroke-width="10" stroke-linecap="square"/><line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#fff" stroke-width="4" stroke-linecap="square"/>${dimLine(a,b,i)}`}).join('');
  const ordered=[...(room.elements||[])].sort((a,b)=>visualLayer(a)-visualLayer(b));
  const elems=ordered.map(e=>{
    const free=isFreePlanType(e.type)||e.free===true,wi=elementWallIndex(e,room),w=walls[wi]||walls[0];if(!w)return'';const [a,b]=w,dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy)||1,ux=dx/len,uy=dy/len,iv=inward(a,b),nx=iv[0],ny=iv[1];
    if(free){const fw=Math.max(22,(e.width||.8)*scale),fd=Math.max(18,(e.depth||.6)*scale),x=(Number.isFinite(e.freeX)?e.freeX:.5)*W,y=(Number.isFinite(e.freeY)?e.freeY:.58)*H;return `<rect x="${x-fw/2}" y="${y-fd/2}" width="${fw}" height="${fd}" rx="4" fill="#f3efe9" stroke="#77838c" stroke-width="1.2"/><text x="${x}" y="${y+3}" font-size="7" font-weight="700" text-anchor="middle" fill="#68747d">${htmlSafe(e.type)}</text>`;}
    const x1=a[0]+ux*(e.left*scale),y1=a[1]+uy*(e.left*scale),x2=a[0]+ux*((e.left+e.width)*scale),y2=a[1]+uy*((e.left+e.width)*scale);
    if(e.type==='Porta'){const hx=e.swing==='right'?x2:x1,hy=e.swing==='right'?y2:y1,ex=hx+nx*(e.width*scale),ey=hy+ny*(e.width*scale),r=Math.max(12,e.width*scale);return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="12"/><line x1="${hx}" y1="${hy}" x2="${ex}" y2="${ey}" stroke="#40505d" stroke-width="1.5"/><path d="M ${hx+r*ux} ${hy+r*uy} A ${r} ${r} 0 0 1 ${ex} ${ey}" fill="none" stroke="#8b98a4" stroke-width="1" stroke-dasharray="3 3"/><text x="${(x1+x2)/2+nx*14}" y="${(y1+y2)/2+ny*14}" font-size="7" text-anchor="middle" fill="#46515c">PORTA</text>`;}
    if(e.type==='Janela')return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="12"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#587487" stroke-width="4"/><line x1="${x1+nx*4}" y1="${y1+ny*4}" x2="${x2+nx*4}" y2="${y2+ny*4}" stroke="#9bb2c0" stroke-width="1.3"/><text x="${(x1+x2)/2+nx*14}" y="${(y1+y2)/2+ny*14}" font-size="7" text-anchor="middle" fill="#46515c">JANELA</text>`;
    if(e.type==='Passagem')return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#101820" stroke-width="14"/><text x="${(x1+x2)/2}" y="${(y1+y2)/2+2}" font-size="2.4" font-weight="700" text-anchor="middle" fill="#ffffff">PASSAGEM</text>`;
    const dep=Math.max(10,(e.depth||.25)*scale),along=Math.max(10,(e.width||.15)*scale),mx=(x1+x2)/2,my=(y1+y2)/2,cx2=mx+nx*dep/2,cy2=my+ny*dep/2,ax=ux*along/2,ay=uy*along/2,bx=nx*dep/2,by=ny*dep/2,pts=[[cx2-ax-bx,cy2-ay-by],[cx2+ax-bx,cy2+ay-by],[cx2+ax+bx,cy2+ay+by],[cx2-ax+bx,cy2-ay+by]].map(p=>p.join(',')).join(' '),fill=isEquipment(e.type)?'#eef1f2':isStructure(e.type)?'#d9dee1':'#f4f6f7';return `<polygon points="${pts}" fill="${fill}" stroke="#65717a" stroke-width="1"/><text x="${cx2}" y="${cy2+2}" font-size="6.3" font-weight="700" text-anchor="middle" fill="#59646c">${htmlSafe(e.type)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="390" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="grid" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#dce6ee" stroke-width=".7"/></pattern></defs><rect width="100%" height="100%" fill="#fff"/><rect x="12" y="12" width="${W-24}" height="${H-24}" rx="10" fill="url(#grid)" stroke="#dfe7ed"/>${wallLines}${elems}</svg>`;
};

const reportFrontSvg=(room,i=0)=>{
  const wallW=(room.lengths||[])[i]||3.2,W=560,H=330,x=45,y=48,wallH=room.height||2.65,px=Math.min((W-100)/wallW,(H-90)/wallH),ww=wallW*px,hh=wallH*px,objects=(room.elements||[]).filter(e=>elementWallIndex(e,room)===i&&(!isFreePlanType(e.type)||isInternalWall(e.type))&&(e.free!==true||isInternalWall(e.type))).map(e=>frontObjectForRoom(e,i,room)).sort((a,b)=>visualLayer(a)-visualLayer(b));
  const objs=objects.map((e,k)=>{const ex=x+e.left*px,ey=y+(wallH-e.bottom-e.height)*px,ew=Math.max(isInternalWall(e.type)?4:5,e.width*px),eh=Math.max(5,e.height*px),fill=isInternalWall(e.type)?'#cbd1d4':e.type==='Porta'?'#c99a68':e.type==='Janela'?'#cdeaf5':isEquipment(e.type)?'#dfe3e5':isStructure(e.type)?'#cbd1d4':isReservedSpace(e.type)?'#ffffff':'#fff';const detail=e.type==='Porta'?`<circle cx="${ex+ew*.83}" cy="${ey+eh*.52}" r="2" fill="#30363a"/>`:e.type==='Janela'?`<line x1="${ex+ew/2}" y1="${ey}" x2="${ex+ew/2}" y2="${ey+eh}" stroke="#6b808a"/><line x1="${ex}" y1="${ey+eh/2}" x2="${ex+ew}" y2="${ey+eh/2}" stroke="#6b808a"/>`:'';return `<g><rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" fill="${fill}" stroke="#58636a" stroke-width="${isInternalWall(e.type)?1.5:1.1}"/>${detail}</g>`}).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="255" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#eef2f5"/><rect x="${x+4}" y="${y+5}" width="${ww}" height="${hh}" fill="#c4cbd0" opacity=".3"/><rect x="${x}" y="${y}" width="${ww}" height="${hh}" fill="#faf8f4" stroke="#30363a" stroke-width="2.2"/><rect x="${x}" y="${y+hh}" width="${ww}" height="22" fill="#ddd4c8"/><line x1="${x}" y1="${y-18}" x2="${x+ww}" y2="${y-18}" stroke="#586572" stroke-width=".8"/><text x="${x+ww/2}" y="${y-22}" font-size="8" text-anchor="middle" fill="#46515c">${numFmt(wallW)} m</text><line x1="${x+ww+18}" y1="${y}" x2="${x+ww+18}" y2="${y+hh}" stroke="#586572" stroke-width=".8"/><text x="${x+ww+29}" y="${y+hh/2}" font-size="8" fill="#46515c" transform="rotate(90 ${x+ww+29} ${y+hh/2})">${numFmt(wallH)} m</text>${objs}</svg>`;
};
const reportPerspectiveSvg=(room,focus=0)=>{
  const W=560,H=320,count=room.wallCount||1;
  if(count===1)return '';
  const back=count===4?focus%4:focus%Math.max(1,count),left=count===4?(back+3)%4:(back+count-1)%count,right=count===4?(back+1)%4:(back+1)%count;
  const wallLabel=(idx,x,y)=>`<text x="${x}" y="${y}" font-size="9" fill="#687078" text-anchor="middle">Parede ${String.fromCharCode(65+idx)}</text>`;
  const obj=(e,x,y,w,h)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${e.type==='Porta'?'#c79a6b':e.type==='Janela'?'#c9e8f4':isEquipment(e.type)?'#d7dcdf':'#cbd0d3'}" stroke="#525c62"/><polygon points="${x+w},${y} ${x+w+8},${y+5} ${x+w+8},${y+h+5} ${x+w},${y+h}" fill="#9ca5aa" stroke="#525c62" stroke-width=".6"/>`;
  const elems=(idx,area)=>{const ww=room.lengths[idx]||3.2;return (room.elements||[]).filter(e=>e.wall===idx).map(e=>{const x=area.x+(e.left/ww)*area.w,y=area.y+(1-(e.bottom+e.height)/(room.height||2.65))*area.h,w=Math.max(5,(e.width/ww)*area.w),h=Math.max(5,(e.height/(room.height||2.65))*area.h);return obj(e,x,y,w,h)}).join('')};
  const backA={x:160,y:44,w:240,h:174},leftA={x:28,y:78,w:132,h:174},rightA={x:400,y:78,w:132,h:174};
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="260" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="pf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eee7dc"/><stop offset="1" stop-color="#cfc4b4"/></linearGradient></defs><rect width="100%" height="100%" fill="#dde3e6"/><polygon points="28,252 160,218 400,218 532,252 558,315 2,315" fill="url(#pf)" stroke="#555c60"/>${[.2,.4,.6,.8].map(t=>`<line x1="280" y1="218" x2="${10+540*t}" y2="315" stroke="#b9aea0" stroke-width=".7"/>`).join('')}<polygon points="28,78 160,44 160,218 28,252" fill="#efede8" stroke="#30363a" stroke-width="2"/><rect x="160" y="44" width="240" height="174" fill="#faf8f4" stroke="#30363a" stroke-width="2"/><polygon points="400,44 532,78 532,252 400,218" fill="#e9e7e3" stroke="#30363a" stroke-width="2"/>${wallLabel(left,92,96)}${wallLabel(back,280,60)}${wallLabel(right,468,96)}${elems(left,leftA)}${elems(back,backA)}${elems(right,rightA)}</svg>`;
};
const pdfHtml=(project,room,selection={})=>{
  const frontWall=selection.frontWall??0;
  const walls=(room.lengths||[]).map((v,i)=>`<tr><td>Parede ${String.fromCharCode(65+i)}</td><td>${mFmt(v)}</td><td>${mFmt(room.height||2.65)}</td></tr>`).join('');
  const items=(room.elements||[]).map(e=>{const free=isFreePlanType(e.type)||e.free===true,local=free?'Livre no ambiente':`Parede ${String.fromCharCode(65+elementWallIndex(e,room))}`,right=free?'—':mFmt(Math.max(0,(room.lengths[e.wall]||0)-e.left-e.width)),left=free?'—':mFmt(e.left),floor=free?'—':mFmt(e.bottom);return `<tr><td>${htmlSafe(e.type)}</td><td>${htmlSafe(groupOf(e.type))}</td><td>${local}</td><td>${htmlSafe(dimensionText(e))}</td><td>${left}</td><td>${right}</td><td>${floor}</td></tr>`}).join('');
  const photos=(room.photos||[]).map((photo,i)=>{const src=photo?.dataUri||photo?.uri||'';return src?`<div class="photo"><div class="photolabel">Foto ${i+1}</div><img src="${htmlSafe(src)}"/></div>`:''}).filter(Boolean).join('');
  const photoBlock=photos?`<div class="box"><div class="k">Fotos do ambiente</div><div class="photos">${photos}</div></div>`:`<div class="box"><div class="k">Fotos do ambiente</div><div class="empty">Nenhuma foto foi adicionada a este ambiente.</div></div>`;
  const relevantWalls=(room.lengths||[]).map((_v,i)=>i).filter(i=>(room.elements||[]).some(e=>e.wall===i&&!isFreePlanType(e.type)&&e.free!==true));
  const fronts=(relevantWalls.length?relevantWalls:[frontWall]).map(i=>`<div class="front"><div class="fronttitle">VISTA FRONTAL · PAREDE ${String.fromCharCode(65+i)}</div>${reportFrontSvg(room,i)}</div>`).join('');
  const notes=`<div class="box"><div class="k">Notas</div><p>${room.notes?htmlSafe(room.notes).replace(/\n/g,'<br>'):'Nenhuma nota registrada para este ambiente.'}</p></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:11mm}body{font-family:Arial,Helvetica,sans-serif;color:#101820;margin:0;background:#fff}h1{font-size:22px;margin:0;letter-spacing:.4px}h2{font-size:18px;margin:5px 0 3px}.meta{color:#607086;margin-bottom:10px;font-size:12px}.box{border:1px solid #d8e0e9;border-radius:10px;padding:10px;margin:10px 0;page-break-inside:avoid}.hero{page-break-inside:avoid}.front{border:1px solid #d8e0e9;border-radius:10px;margin:10px 0;padding:8px;page-break-inside:avoid}.fronttitle{font-size:11px;font-weight:bold;color:#1677f2;margin:2px 0 6px;letter-spacing:.5px}.photos{display:flex;flex-wrap:wrap;gap:8px}.photo{width:calc(50% - 5px);page-break-inside:avoid}.photo img{display:block;width:100%;height:230px;object-fit:contain;border-radius:7px;background:#eef2f5}.photolabel{font-size:9px;color:#64748b;margin-bottom:4px}table{width:100%;border-collapse:collapse;font-size:10px}th,td{padding:5px;border-bottom:1px solid #e8edf2;text-align:left;vertical-align:top}th{background:#f3f6f9}.k{font-size:10px;font-weight:bold;color:#1677f2;text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px}.footer{margin-top:18px;font-size:10px;color:#607086}.empty{padding:28px;text-align:center;color:#778392;background:#f6f8fa;border-radius:8px}.pagebreak{page-break-before:always}</style></head><body><div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #101820;padding-bottom:10px;margin-bottom:10px"><div><div style="font-size:9px;color:#1677f2;font-weight:700;letter-spacing:1.2px">MEDIÇÃO DO AMBIENTE</div><h1>GW Medidas</h1></div><div style="font-size:9px;color:#64748b;text-align:right">Arquivo de medição<br>gerado pelo aplicativo</div></div><h2>${htmlSafe(project.name)} · ${htmlSafe(room.name)}</h2><div class="meta"><b>Cliente:</b> ${htmlSafe(project.client)} · ${room.wallCount} parede${room.wallCount!==1?'s':''} · ${(room.photos||[]).length} foto${(room.photos||[]).length!==1?'s':''}</div><div class="box hero"><div class="k">Planta principal</div>${reportPlanSvg(room)}</div><div class="pagebreak"></div>${fronts}${photoBlock}<div class="box"><div class="k">Ficha técnica · paredes</div><table><tr><th>Parede</th><th>Largura</th><th>Altura</th></tr>${walls}</table></div><div class="box"><div class="k">Ficha técnica · itens</div><table><tr><th>Item</th><th>Grupo</th><th>Local</th><th>Dimensões</th><th>Esquerda</th><th>Direita</th><th>Piso</th></tr>${items||'<tr><td colspan="7">Nenhum elemento registrado.</td></tr>'}</table></div>${notes}<div class="footer">Medição exportada pelo GW Medidas.</div></body></html>`;
};



const safeFileName=s=>String(s||'medicao').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9-_]+/g,'-').replace(/^-+|-+$/g,'');
const projectPdfHtml=(project,rooms,wallsByRoom={})=>{
  const sectionFor=(room,idx)=>{
    const walls=(room.lengths||[]).map((v,i)=>`<tr><td>Parede ${String.fromCharCode(65+i)}</td><td>${htmlSafe(mFmt(v))}</td><td>${htmlSafe(mFmt(room.height||2.65))}</td></tr>`).join('');
    const items=(room.elements||[]).map(e=>{const free=isFreePlanType(e.type)||e.free===true,local=free?'Livre no ambiente':`Parede ${String.fromCharCode(65+(e.wall||0))}`,right=free?'—':mFmt(Math.max(0,(room.lengths[e.wall]||0)-e.left-e.width)),left=free?'—':mFmt(e.left),floor=free?'—':mFmt(e.bottom);return `<tr><td>${htmlSafe(e.type)}</td><td>${htmlSafe(groupOf(e.type))}</td><td>${htmlSafe(local)}</td><td>${htmlSafe(dimensionText(e))}</td><td>${left}</td><td>${right}</td><td>${floor}</td></tr>`}).join('');
    const chosenWall=Number.isInteger(wallsByRoom?.[room.id])?wallsByRoom[room.id]:0;
    const fronts=`<div class="front"><div class="fronttitle">VISTA FRONTAL · PAREDE ${String.fromCharCode(65+chosenWall)}</div>${reportFrontSvg(room,chosenWall)}</div>`;
    const photos=(room.photos||[]).map((photo,i)=>{const src=photo?.dataUri||photo?.uri||'';return src?`<div class="photo"><div class="photolabel">Foto ${i+1}</div><img src="${htmlSafe(src)}"/></div>`:''}).filter(Boolean).join('');
    const photoBlock=photos?`<div class="box"><div class="k">Fotos do ambiente</div><div class="photos">${photos}</div></div>`:`<div class="box"><div class="k">Fotos do ambiente</div><div class="empty">Nenhuma foto adicionada a este ambiente.</div></div>`;
    const notes=`<div class="box"><div class="k">Notas</div><div class="note">${room.notes?.trim()?htmlSafe(room.notes).replace(/\n/g,'<br>'):'Nenhuma nota registrada para este ambiente.'}</div></div>`;
    return `${idx?'<div class="pagebreak"></div>':''}<div class="roomhead"><div class="eyebrow">AMBIENTE ${idx+1}</div><h2>${htmlSafe(room.name)}</h2><div class="meta">${room.wallCount} parede${room.wallCount!==1?'s':''} · ${(room.elements||[]).length} item${(room.elements||[]).length!==1?'s':''} · ${(room.photos||[]).length} foto${(room.photos||[]).length!==1?'s':''}</div></div><div class="box hero"><div class="k">Planta principal</div>${reportPlanSvg(room)}</div>${fronts}${photoBlock}<div class="box"><div class="k">Resumo técnico · paredes</div><table><tr><th>Parede</th><th>Largura</th><th>Altura</th></tr>${walls}</table></div><div class="box"><div class="k">Resumo técnico · itens</div><table><tr><th>Item</th><th>Grupo</th><th>Local</th><th>Dimensões</th><th>Esquerda</th><th>Direita</th><th>Piso</th></tr>${items||'<tr><td colspan="7">Nenhum elemento registrado.</td></tr>'}</table></div>${notes}`;
  };
  const sections=rooms.map(sectionFor).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:10mm}body{font-family:Arial,Helvetica,sans-serif;color:#101820;margin:0;background:#fff}h1{font-size:22px;margin:0;letter-spacing:.3px}h2{font-size:18px;margin:2px 0 3px}.head{border-bottom:2px solid #101820;padding-bottom:9px;margin-bottom:10px}.eyebrow{font-size:9px;color:#1677f2;font-weight:800;letter-spacing:.9px}.meta{font-size:10px;color:#64748b;margin-bottom:7px}.roomhead{margin:2px 0 6px}.box{border:1px solid #d8e0e9;border-radius:9px;padding:8px;margin:7px 0;page-break-inside:avoid}.hero{page-break-inside:avoid}.front{border:1px solid #d8e0e9;border-radius:9px;margin:7px 0;padding:7px;page-break-inside:avoid}.fronttitle{font-size:10px;font-weight:800;color:#1677f2;margin:1px 0 5px;letter-spacing:.5px}.k{font-size:9px;font-weight:bold;color:#1677f2;text-transform:uppercase;letter-spacing:.7px;margin-bottom:6px}.photos{display:flex;flex-wrap:wrap;gap:7px}.photo{width:calc(50% - 4px);page-break-inside:avoid}.photo img{display:block;width:100%;height:190px;object-fit:contain;border-radius:7px;background:#eef2f5}.photolabel{font-size:8px;color:#64748b;margin-bottom:3px}.empty{padding:18px;text-align:center;color:#778392;background:#f6f8fa;border-radius:7px}.note{font-size:10px;line-height:1.45}table{width:100%;border-collapse:collapse;font-size:8.6px}th,td{padding:4px;border-bottom:1px solid #e8edf2;text-align:left;vertical-align:top}th{background:#f3f6f9}.pagebreak{page-break-before:always}.footer{margin-top:14px;font-size:9px;color:#607086}</style></head><body><div class="head"><div class="eyebrow">GW MEDIDAS · PROJETO COMPLETO</div><h1>${htmlSafe(project.client)} · ${htmlSafe(project.name)}</h1><div class="meta">${rooms.length} ambiente${rooms.length!==1?'s':''} no arquivo: ${rooms.map(r=>htmlSafe(r.name)).join(' · ')}</div></div>${sections}<div class="footer">Projeto exportado pelo GW Medidas.</div></body></html>`;
};

const exportWebPdf=async(html,fileName)=>{
  const {jsPDF}=await import('jspdf');
  const parsed=new DOMParser().parseFromString(html,'text/html');
  const host=document.createElement('div');
  host.style.position='fixed';host.style.left='-12000px';host.style.top='0';host.style.width='760px';host.style.background='#fff';host.style.zIndex='-1';
  const style=document.createElement('style');style.textContent=parsed.head.querySelector('style')?.textContent||'';host.appendChild(style);
  const body=document.createElement('div');body.innerHTML=parsed.body.innerHTML;host.appendChild(body);document.body.appendChild(host);
  try{
    const doc=new jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
    await doc.html(body,{margin:[10,10,10,10],autoPaging:'text',width:190,windowWidth:760,html2canvas:{scale:.72,useCORS:true,backgroundColor:'#ffffff'}});
    const blob=doc.output('blob'), file=new File([blob],fileName,{type:'application/pdf'});
    if(navigator.share && navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:'GW Medidas',text:'Medição exportada pelo GW Medidas'});
    }else{
      doc.save(fileName);
    }
  }finally{host.remove();}
};


function ClientsScreen({projects,quickJobs=[],onBack}){
  const clients=useMemo(()=>{const m=new Map();projects.forEach(p=>{const k=(p.client||'Sem cliente').trim()||'Sem cliente',cur=m.get(k)||{name:k,projects:0,budgets:0,local:0,rooms:0};if(p.gwSourceType==='orcamento')cur.budgets+=1;else if(p.gwSourceType==='projeto')cur.projects+=1;else cur.local+=1;cur.rooms+=(p.rooms||[]).length;m.set(k,cur)});quickJobs.forEach(q=>{const k=(q.client||'Sem cliente').trim()||'Sem cliente',cur=m.get(k)||{name:k,projects:0,budgets:0,local:0,rooms:0,quick:0};cur.quick=(cur.quick||0)+1;m.set(k,cur)});return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'))},[projects,quickJobs]);
  return <View style={styles.screen}><Header title="Clientes" subtitle={`${clients.length} cliente${clients.length!==1?'s':''}`} onBack={onBack}/><ScrollView contentContainerStyle={styles.simplePage}>{clients.length?clients.map(c=><View key={c.name} style={styles.infoCard}><View style={styles.infoIcon}><Text style={styles.infoIconText}>{c.name.slice(0,1).toUpperCase()}</Text></View><View style={{flex:1}}><Text style={styles.infoTitle}>{c.name}</Text><Text style={styles.infoText}>{c.budgets} orçamento{c.budgets!==1?'s':''} · {c.projects} projeto{c.projects!==1?'s':''} · {c.rooms} ambiente{c.rooms!==1?'s':''}{c.quick?` · ${c.quick} medição rápida${c.quick!==1?'s':''}`:''}{c.local?` · ${c.local} local`:''}</Text></View></View>):<Text style={styles.emptyHomeText}>Os clientes aparecerão aqui conforme você criar medições ou sincronizar o GW.</Text>}</ScrollView></View>
}
function HelpScreen({onBack}){
  const rows=[['1','Crie um projeto e um ambiente.'],['2','Informe as paredes e medidas do cômodo.'],['3','Adicione portas, janelas, equipamentos e pontos.'],['4','Toque fora dos itens para liberar zoom e navegação.'],['5','Toque em um item para selecionar; depois ajuste ou mova.'],['6','Use Resumo e Exportar para fechar a medição.']];
  return <View style={styles.screen}><Header title="Ajuda" subtitle="Como usar o GW Medidas" onBack={onBack}/><ScrollView contentContainerStyle={styles.simplePage}>{rows.map(([n,t])=><View key={n} style={styles.helpRow}><View style={styles.helpNum}><Text style={styles.helpNumText}>{n}</Text></View><Text style={styles.helpText}>{t}</Text></View>)}</ScrollView></View>
}
function MoreScreen({onBack,onNew,onIntegration}){
  return <View style={styles.screen}><Header title="Mais" subtitle="GW Medidas" onBack={onBack}/><ScrollView contentContainerStyle={styles.simplePage}>
    <Pressable onPress={onNew} style={styles.moreAction}><Text style={styles.moreActionTitle}>＋ Nova medição</Text><Text style={styles.moreActionText}>Criar um novo ambiente ou projeto.</Text></Pressable>
    <Pressable onPress={onIntegration} style={[styles.moreAction,{backgroundColor:'#101820'}]}><Text style={styles.moreActionTitle}>↔ GW Assistente</Text><Text style={styles.moreActionText}>Trazer clientes, orçamentos, projetos e ambientes da sua conta GW.</Text></Pressable>
    <View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>GW Medidas</Text><Text style={styles.infoText}>Medição técnica para marcenaria · versão 6.6.6</Text></View></View>
    <View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Integração · Etapa 2</Text><Text style={styles.infoText}>Orçamento recebe levantamento antes da aprovação; projeto aprovado recebe atualizações; medição local pode ser vinculada ao GW.</Text></View></View>
  </ScrollView></View>
}

function GwIntegrationScreen({projects,onBack,onSynced}){
  const [session,setSession]=useState(null);
  const [checking,setChecking]=useState(true);
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [last,setLast]=useState(null);

  useEffect(()=>{
    let alive=true;
    gwGetSession().then(value=>{if(alive)setSession(value)}).catch(()=>{}).finally(()=>{if(alive)setChecking(false)});
    return ()=>{alive=false};
  },[]);

  const syncNow=async()=>{
    setBusy(true);setMessage('');
    try{
      const payload=await gwLoadWorkspaceProjects();
      const next=mergeGwProjects(projects,payload);
      await onSynced(next);
      const imported=next.filter(p=>p.gwImported).length;
      const rooms=next.filter(p=>p.gwImported).reduce((n,p)=>n+(p.rooms||[]).length,0);
      const budgets=next.filter(p=>p.gwImported&&p.gwSourceType==='orcamento').length;
      const realProjects=next.filter(p=>p.gwImported&&p.gwSourceType==='projeto').length;
      setLast({projects:realProjects,budgets,rooms,clients:(payload.clientes||[]).length});
      setMessage(`Sincronizado: ${budgets} orçamento(s) · ${realProjects} projeto(s) · ${rooms} ambiente(s).`);
    }catch(e){
      setMessage(e?.message||'Não consegui sincronizar com o GW Assistente.');
    }finally{setBusy(false)}
  };

  const login=async()=>{
    if(!email.trim()||!password){setMessage('Informe o mesmo e-mail e senha usados no GW Assistente.');return}
    setBusy(true);setMessage('');
    try{const sess=await gwSignIn(email,password);setSession(sess);setPassword('');setMessage('Conta conectada. Agora toque em Sincronizar GW.')}
    catch(e){setMessage(e?.message==='Invalid login credentials'?'E-mail ou senha incorretos.':(e?.message||'Não consegui entrar na conta GW.'))}
    finally{setBusy(false)}
  };

  const logout=async()=>{
    setBusy(true);
    try{await gwSignOut();setSession(null);setLast(null);setMessage('Conta desconectada.')}catch(e){setMessage(e?.message||'Não consegui sair agora.')}finally{setBusy(false)}
  };

  return <View style={styles.screen}><Header title="GW Assistente" subtitle="Integração · Etapa 2" onBack={onBack}/><ScrollView contentContainerStyle={styles.simplePage} keyboardShouldPersistTaps="handled">
    <View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Somente leitura</Text><Text style={styles.infoText}>O GW Medidas lê clientes, orçamentos e projetos. O envio só acontece quando você toca no botão dentro da medição vinculada.</Text></View></View>
    {!gwCloudConfigured?<View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Integração não configurada</Text><Text style={styles.infoText}>A configuração de conexão não foi encontrada neste pacote.</Text></View></View>:checking?<View style={styles.infoCard}><Text style={styles.infoText}>Verificando sua sessão...</Text></View>:session?<><View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Conta GW conectada</Text><Text style={styles.infoText}>{session?.user?.email||'Usuário autenticado'}</Text></View></View><Pressable disabled={busy} onPress={syncNow} style={[styles.moreAction,busy&&{opacity:.55}]}><Text style={styles.moreActionTitle}>{busy?'Sincronizando...':'↓ Sincronizar GW'}</Text><Text style={styles.moreActionText}>Trazer orçamentos em negociação e projetos aprovados, sem gravar nada no Assistente.</Text></Pressable>{last?<View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Última sincronização</Text><Text style={styles.infoText}>{last.clients} cliente(s) · {last.budgets||0} orçamento(s) · {last.projects} projeto(s) · {last.rooms} ambiente(s)</Text></View></View>:null}<Pressable disabled={busy} onPress={logout} style={[styles.infoCard,{justifyContent:'center'}]}><Text style={[styles.infoTitle,{color:'#C62828'}]}>Desconectar conta</Text></Pressable></>:<><View><Text style={styles.label}>E-mail do GW Assistente</Text><TextInput autoCapitalize="none" keyboardType="email-address" style={styles.input} value={email} onChangeText={setEmail} placeholder="seu@email.com" placeholderTextColor="#9AA6B5"/></View><View><Text style={styles.label}>Senha</Text><TextInput secureTextEntry style={styles.input} value={password} onChangeText={setPassword} placeholder="Sua senha" placeholderTextColor="#9AA6B5"/></View><Pressable disabled={busy} onPress={login} style={[styles.moreAction,busy&&{opacity:.55}]}><Text style={styles.moreActionTitle}>{busy?'Entrando...':'Entrar com minha conta GW'}</Text><Text style={styles.moreActionText}>Use a mesma conta que abre o GW Assistente.</Text></Pressable></>}
    {message?<View style={styles.infoCard}><View style={{flex:1}}><Text style={styles.infoTitle}>Status</Text><Text style={styles.infoText}>{message}</Text></View></View>:null}
  </ScrollView></View>
}

function confirmDelete(title,message,onConfirm){
  if(Platform.OS==='web' && typeof window!=='undefined'){
    if(window.confirm(`${title}\n\n${message}`)) onConfirm?.();
    return;
  }
  Alert.alert(title,message,[{text:'Cancelar',style:'cancel'},{text:'Excluir',style:'destructive',onPress:onConfirm}]);
}



function MeasurementModeHome({onBack,onQuick,onComplete}){
  return <View style={styles.screen}><View style={styles.modeTop}><Text style={styles.brand}><Text style={{color:INK}}>GW</Text> <Text style={{color:BLUE}}>MEDIDAS</Text></Text><Text style={styles.modeTitle}>Como você quer medir hoje?</Text><Text style={styles.modeSub}>Escolha o modo ideal para o serviço.</Text></View><View style={styles.modeCards}>
    <Pressable onPress={onQuick} style={[styles.modeCard,styles.modeCardQuick]}><View style={styles.modeIcon}><Text style={styles.modeIconText}>⚡</Text></View><View style={{flex:1}}><Text style={styles.modeCardTitle}>Medição rápida</Text><Text style={styles.modeCardText}>Fotografe a parede e marque as medidas direto na imagem.</Text><Text style={styles.modeCardHint}>Foto → cota → medida</Text></View><Text style={styles.modeArrow}>›</Text></Pressable>
    <Pressable onPress={onComplete} style={styles.modeCard}><View style={styles.modeIcon}><Text style={styles.modeIconText}>⌗</Text></View><View style={{flex:1}}><Text style={styles.modeCardTitle}>Medição completa</Text><Text style={styles.modeCardText}>Planta, paredes, equipamentos, pontos, fotos, cotas e levantamento técnico.</Text><Text style={styles.modeCardHint}>Fluxo profissional completo</Text></View><Text style={styles.modeArrow}>›</Text></Pressable>
  </View><Pressable onPress={onBack} style={styles.modeBack}><Text style={styles.back}>‹ Voltar</Text></Pressable></View>
}

function QuickMeasurementForm({onBack,onContinue}){
  const [client,setClient]=useState(''),[project,setProject]=useState(''),[phone,setPhone]=useState(''),[address,setAddress]=useState('');
  const ready=client.trim()&&project.trim();
  return <ScrollView style={styles.screen} keyboardShouldPersistTaps="handled"><Header title="Medição rápida" subtitle="Identificação do serviço" onBack={onBack}/><View style={styles.pad}>
    <View style={styles.quickInfo}><Text style={styles.quickInfoTitle}>Só o essencial</Text><Text style={styles.quickInfoText}>Preencha os dados básicos e vá direto para a câmera.</Text></View>
    <Field label="Cliente" value={client} onChangeText={setClient} placeholder="Ex.: João Silva"/>
    <Field label="Projeto / serviço" value={project} onChangeText={setProject} placeholder="Ex.: Cozinha"/>
    <Field label="Telefone (opcional)" value={phone} onChangeText={setPhone} placeholder="(15) 99999-9999"/>
    <Field label="Endereço (opcional)" value={address} onChangeText={setAddress} placeholder="Rua, número, bairro"/>
    <Button disabled={!ready} title="Continuar para foto" onPress={()=>onContinue({id:uid(),client:client.trim(),project:project.trim(),phone:phone.trim(),address:address.trim(),photos:[],createdAt:Date.now()})}/>
  </View></ScrollView>
}

function QuickPhotoMeasure({job,onBack,onUpdate,onSave,onFinish}){
  const [activePhoto,setActivePhoto]=useState(()=>job?.photos?.[job.photos.length-1]||null);
  const [tool,setTool]=useState('navigate');
  const [draftLine,setDraftLine]=useState(null),[pendingLine,setPendingLine]=useState(null),[measureValue,setMeasureValue]=useState('');
  const [draftArea,setDraftArea]=useState(null),[pendingArea,setPendingArea]=useState(null),[areaValue,setAreaValue]=useState('');
  const [anglePoints,setAnglePoints]=useState([]);
  const [textPoint,setTextPoint]=useState(null),[textOpen,setTextOpen]=useState(false),[textValue,setTextValue]=useState('');
  const [noteOpen,setNoteOpen]=useState(false),[noteValue,setNoteValue]=useState(()=>activePhoto?.note||'');
  const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0});
  const zoomRef=useRef(1),offsetRef=useRef({x:0,y:0}),panStartRef=useRef({x:0,y:0});
  useEffect(()=>{zoomRef.current=zoom},[zoom]); useEffect(()=>{offsetRef.current=offset},[offset]);
  const boxW=APP_W-24,boxH=Math.round(boxW*1.18);
  const chooseTool=t=>{setTool(v=>v===t?'navigate':t);setAnglePoints([])};
  const resetView=()=>{setZoom(1);setOffset({x:0,y:0});setTool('navigate');setAnglePoints([])};
  const updatePhoto=updated=>{const next={...job,photos:(job.photos||[]).map(p=>p.id===updated.id?updated:p),updatedAt:Date.now()};onUpdate(next);setActivePhoto(updated);return next};
  const addPhoto=async(source='camera')=>{if(job?.photos?.length)await onSave?.(job,true);let r;if(source==='camera'){const perm=await ImagePicker.requestCameraPermissionsAsync();if(!perm.granted){Alert.alert('Câmera','Autorize o acesso à câmera para fazer a medição rápida.');return;}r=await ImagePicker.launchCameraAsync({mediaTypes:['images'],quality:.82,base64:true});}else r=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],quality:.82,base64:true});if(r?.canceled)return;const a=r.assets[0],photo={id:uid(),uri:a.uri,dataUri:a.base64?`data:${a.mimeType||'image/jpeg'};base64,${a.base64}`:null,marks:[],createdAt:Date.now()};const next={...job,photos:[...(job.photos||[]),photo],updatedAt:Date.now()};onUpdate(next);setActivePhoto(photo);resetView()};
  const localPoint=e=>({x:clamp((e.x-offsetRef.current.x-boxW/2)/(boxW*zoomRef.current)+.5,0,1),y:clamp((e.y-offsetRef.current.y-boxH/2)/(boxH*zoomRef.current)+.5,0,1)});
  const drawPan=useMemo(()=>Gesture.Pan().minDistance(2).runOnJS(true).onBegin(e=>{if(tool==='measure'){const q=localPoint(e);setDraftLine({x1:q.x,y1:q.y,x2:q.x,y2:q.y})}else if(tool==='area'){const q=localPoint(e);setDraftArea({x1:q.x,y1:q.y,x2:q.x,y2:q.y})}else if(tool==='navigate'){panStartRef.current=offsetRef.current}}).onUpdate(e=>{if(tool==='measure'){const q=localPoint(e);setDraftLine(d=>d?{...d,x2:q.x,y2:q.y}:d)}else if(tool==='area'){const q=localPoint(e);setDraftArea(d=>d?{...d,x2:q.x,y2:q.y}:d)}else if(tool==='navigate'){setOffset({x:panStartRef.current.x+e.translationX,y:panStartRef.current.y+e.translationY})}}).onEnd(e=>{if(tool==='measure'){setDraftLine(d=>{if(!d)return null;const q=localPoint(e),line={...d,x2:q.x,y2:q.y};if(Math.hypot(line.x2-line.x1,line.y2-line.y1)>.02){setPendingLine(line);setMeasureValue('')}return null})}else if(tool==='area'){setDraftArea(d=>{if(!d)return null;const q=localPoint(e),a={...d,x2:q.x,y2:q.y};if(Math.abs(a.x2-a.x1)>.02&&Math.abs(a.y2-a.y1)>.02){setPendingArea(a);setAreaValue('')}return null})}}),[tool,boxW,boxH]);
  const toolTap=useMemo(()=>Gesture.Tap().maxDistance(8).runOnJS(true).onEnd((e,ok)=>{if(!ok)return;const q=localPoint(e);if(tool==='angle'){setAnglePoints(prev=>{const pts=[...prev,q];if(pts.length===3){const [a,b,c]=pts,v1={x:a.x-b.x,y:a.y-b.y},v2={x:c.x-b.x,y:c.y-b.y},dot=v1.x*v2.x+v1.y*v2.y,den=Math.hypot(v1.x,v1.y)*Math.hypot(v2.x,v2.y),deg=den?Math.acos(clamp(dot/den,-1,1))*180/Math.PI:0;const mark={id:uid(),kind:'angle',points:pts,value:`${deg.toFixed(1).replace('.',',')}°`};const updated={...activePhoto,marks:[...(activePhoto.marks||[]),mark]};updatePhoto(updated);setTool('navigate');return []}return pts})}else if(tool==='text'){setTextPoint(q);setTextValue('');setTextOpen(true)}}),[tool,activePhoto,job]);
  const pinch=useMemo(()=>{let base=1;return Gesture.Pinch().runOnJS(true).onBegin(()=>{base=zoomRef.current}).onUpdate(e=>{const z=clamp(base*e.scale,1,5);setZoom(z);if(z===1)setOffset({x:0,y:0})})},[]);
  const photoGesture=useMemo(()=>Gesture.Simultaneous(drawPan,pinch,toolTap),[drawPan,pinch,toolTap]);
  const confirmMeasure=()=>{if(!activePhoto||!pendingLine)return;const value=measureValue.trim();if(!value)return;updatePhoto({...activePhoto,marks:[...(activePhoto.marks||[]),{id:uid(),kind:'line',...pendingLine,value}]});setPendingLine(null);setMeasureValue('');setTool('navigate')};
  const confirmArea=()=>{if(!activePhoto||!pendingArea)return;const value=areaValue.trim();if(!value)return;updatePhoto({...activePhoto,marks:[...(activePhoto.marks||[]),{id:uid(),kind:'area',...pendingArea,value}]});setPendingArea(null);setAreaValue('');setTool('navigate')};
  const confirmText=()=>{if(!activePhoto||!textPoint||!textValue.trim())return;updatePhoto({...activePhoto,marks:[...(activePhoto.marks||[]),{id:uid(),kind:'text',x:textPoint.x,y:textPoint.y,value:textValue.trim()}]});setTextOpen(false);setTextPoint(null);setTextValue('');setTool('navigate')};
  const deleteMark=id=>{if(!activePhoto)return;updatePhoto({...activePhoto,marks:(activePhoto.marks||[]).filter(m=>m.id!==id)})};
  const undoLast=()=>{if(!activePhoto)return;if((activePhoto.marks||[]).length){updatePhoto({...activePhoto,marks:(activePhoto.marks||[]).slice(0,-1)});return}if(activePhoto.note){updatePhoto({...activePhoto,note:''})}};
  if(!activePhoto)return <View style={styles.screen}><Header title="Medição rápida" subtitle={`${job.client} · ${job.project}`} onBack={onBack}/><View style={styles.quickCameraEmpty}><Text style={styles.quickCameraIcon}>📷</Text><Text style={styles.quickCameraTitle}>Fotografe a parede</Text><Text style={styles.quickCameraText}>Adicione uma foto. Depois você poderá ampliar, mover e só então escolher a ferramenta de medição.</Text><View style={styles.quickCameraActions}><Pressable onPress={()=>addPhoto('camera')} style={styles.quickCameraActionPrimary}><Text style={styles.quickCameraActionIcon}>📷</Text><View><Text style={styles.quickCameraActionTitleWhite}>Tirar foto</Text><Text style={styles.quickCameraActionSubWhite}>Abrir câmera</Text></View></Pressable><Pressable onPress={()=>addPhoto('gallery')} style={styles.quickCameraActionSecondary}><Text style={styles.quickCameraActionIcon}>▧</Text><View><Text style={styles.quickCameraActionTitle}>Galeria</Text><Text style={styles.quickCameraActionSub}>Escolher imagem</Text></View></Pressable></View></View></View>;
  const marks=[...(activePhoto.marks||[])];
  // Mantém a geometria visível enquanto o modal de valor está aberto.
  // Antes o rascunho era apagado no onEnd e a linha/área sumia exatamente quando o modal aparecia.
  const visibleLine=draftLine||pendingLine;
  const visibleArea=draftArea||pendingArea;
  const title=tool==='navigate'?'Foto pronta para medir':tool==='measure'?'Medida':tool==='area'?'Área':tool==='angle'?'Ângulo':tool==='text'?'Texto':'Foto pronta para medir';
  const hint=tool==='navigate'?'Arraste para navegar · pinça para zoom':tool==='measure'?'Arraste entre os dois pontos':tool==='area'?'Arraste para delimitar a área':tool==='angle'?`Toque em 3 pontos · ${anglePoints.length}/3`:'Toque no local onde deseja escrever';
  return <View style={styles.screen}><Header title="Medição rápida" subtitle={`${job.client} · ${job.project}`} onBack={onBack}/><ScrollView scrollEnabled={false} contentContainerStyle={{paddingBottom:174}}><View style={styles.quickToolHeader}><View><Text style={styles.quickToolHeaderTitle}>{title}</Text><Text style={styles.quickToolHeaderSub}>{hint}</Text></View>{zoom>1?<Pressable onPress={resetView} style={styles.quickResetZoom}><Text style={styles.quickResetZoomText}>100%</Text></Pressable>:null}</View>
    <View style={[styles.quickPhotoStage,{width:boxW,height:boxH}]}><GestureDetector gesture={photoGesture}><View style={StyleSheet.absoluteFillObject}><View style={[StyleSheet.absoluteFillObject,{transform:[{translateX:offset.x},{translateY:offset.y},{scale:zoom}]}]}><Image source={{uri:activePhoto.uri}} style={[StyleSheet.absoluteFillObject,{zIndex:1}]} resizeMode="contain"/><Svg width={boxW} height={boxH} style={[StyleSheet.absoluteFillObject,{zIndex:20}]} pointerEvents="none">{marks.map(m=>{if(m.kind==='area'){const x=Math.min(m.x1,m.x2)*boxW,y=Math.min(m.y1,m.y2)*boxH,w=Math.abs(m.x2-m.x1)*boxW,h=Math.abs(m.y2-m.y1)*boxH;return <React.Fragment key={m.id}><Rect x={x} y={y} width={w} height={h} rx="4" fill="rgba(22,119,242,.16)" stroke={BLUE} strokeWidth="2"/><Rect x={x+w/2-34} y={y+h/2-13} width="68" height="26" rx="7" fill={WHITE} stroke={BLUE}/><SvgText x={x+w/2} y={y+h/2+5} fontSize="11" fontWeight="800" textAnchor="middle" fill={INK}>{m.value}</SvgText></React.Fragment>}if(m.kind==='text'){return <React.Fragment key={m.id}><Rect x={m.x*boxW-4} y={m.y*boxH-18} width={Math.max(48,m.value.length*7.2)} height="25" rx="5" fill="rgba(255,255,255,.92)" stroke={BLUE}/><SvgText x={m.x*boxW+4} y={m.y*boxH} fontSize="12" fontWeight="700" fill={INK}>{m.value}</SvgText></React.Fragment>}if(m.kind==='angle'){const [a,b,c]=m.points,x1=a.x*boxW,y1=a.y*boxH,x2=b.x*boxW,y2=b.y*boxH,x3=c.x*boxW,y3=c.y*boxH;return <React.Fragment key={m.id}><Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BLUE} strokeWidth="2.5"/><Line x1={x2} y1={y2} x2={x3} y2={y3} stroke={BLUE} strokeWidth="2.5"/><Circle cx={x2} cy={y2} r="5" fill={WHITE} stroke={BLUE} strokeWidth="2"/><Rect x={x2+8} y={y2-28} width="58" height="24" rx="7" fill={WHITE} stroke={BLUE}/><SvgText x={x2+37} y={y2-11} fontSize="11" fontWeight="800" textAnchor="middle" fill={INK}>{m.value}</SvgText></React.Fragment>}const x1=m.x1*boxW,y1=m.y1*boxH,x2=m.x2*boxW,y2=m.y2*boxH,mx=(x1+x2)/2,my=(y1+y2)/2;return <React.Fragment key={m.id}><Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BLUE} strokeWidth="3"/><Circle cx={x1} cy={y1} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2.5"/><Circle cx={x2} cy={y2} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2.5"/><Rect x={mx-36} y={my-13} width="72" height="26" rx="7" fill={WHITE} stroke={BLUE}/><SvgText x={mx} y={my+5} fontSize="12" fontWeight="800" textAnchor="middle" fill={INK}>{m.value}</SvgText></React.Fragment>})}{anglePoints.length?anglePoints.map((p,i)=><Circle key={`ap-${i}`} cx={p.x*boxW} cy={p.y*boxH} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2.5"/>):null}{textPoint?<Circle cx={textPoint.x*boxW} cy={textPoint.y*boxH} r="7" fill={WHITE} stroke={BLUE} strokeWidth="3"/>:null}{anglePoints.length>=1?<Circle cx={anglePoints[0].x*boxW} cy={anglePoints[0].y*boxH} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2"/>:null}{anglePoints.length===2?<><Line x1={anglePoints[0].x*boxW} y1={anglePoints[0].y*boxH} x2={anglePoints[1].x*boxW} y2={anglePoints[1].y*boxH} stroke={BLUE} strokeWidth="3"/><Circle cx={anglePoints[1].x*boxW} cy={anglePoints[1].y*boxH} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2"/></>:null}{visibleLine?(()=>{const x1=visibleLine.x1*boxW,y1=visibleLine.y1*boxH,x2=visibleLine.x2*boxW,y2=visibleLine.y2*boxH;return <><Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BLUE} strokeWidth="3"/><Circle cx={x1} cy={y1} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2"/><Circle cx={x2} cy={y2} r="6" fill={WHITE} stroke={BLUE} strokeWidth="2"/></>})():null}{visibleArea?(()=>{const x=Math.min(visibleArea.x1,visibleArea.x2)*boxW,y=Math.min(visibleArea.y1,visibleArea.y2)*boxH,w=Math.abs(visibleArea.x2-visibleArea.x1)*boxW,h=Math.abs(visibleArea.y2-visibleArea.y1)*boxH;return <><Rect x={x} y={y} width={w} height={h} fill="rgba(22,119,242,.18)" stroke={BLUE} strokeWidth="3"/><Circle cx={x} cy={y} r="5" fill={WHITE} stroke={BLUE}/><Circle cx={x+w} cy={y+h} r="5" fill={WHITE} stroke={BLUE}/></>})():null}</Svg></View></View></GestureDetector></View>
    {activePhoto.note?<Pressable onPress={()=>{setNoteValue(activePhoto.note||'');setNoteOpen(true)}} style={styles.quickNoteCard}><View style={styles.quickNoteIcon}><Text style={styles.quickNoteIconText}>✎</Text></View><View style={{flex:1}}><Text style={styles.quickNoteLabel}>Nota da foto</Text><Text style={styles.quickNoteText}>{activePhoto.note}</Text></View><Text style={styles.chevSmall}>›</Text></Pressable>:null}
  </ScrollView><View style={styles.quickEditorDock}><View style={styles.quickEditorTools}><Pressable onPress={()=>chooseTool('measure')} style={[styles.quickEditorTool,tool==='measure'&&styles.quickEditorToolOn]}><Text style={[styles.quickEditorIcon,tool==='measure'&&styles.quickEditorTextOn]}>↔</Text><Text style={[styles.quickEditorLabel,tool==='measure'&&styles.quickEditorTextOn]}>Medida</Text></Pressable><Pressable onPress={()=>chooseTool('area')} style={[styles.quickEditorTool,tool==='area'&&styles.quickEditorToolOn]}><Text style={[styles.quickEditorIcon,tool==='area'&&styles.quickEditorTextOn]}>▭</Text><Text style={[styles.quickEditorLabel,tool==='area'&&styles.quickEditorTextOn]}>Área</Text></Pressable><Pressable onPress={()=>chooseTool('angle')} style={[styles.quickEditorTool,tool==='angle'&&styles.quickEditorToolOn]}><Text style={[styles.quickEditorIcon,tool==='angle'&&styles.quickEditorTextOn]}>∠</Text><Text style={[styles.quickEditorLabel,tool==='angle'&&styles.quickEditorTextOn]}>Ângulo</Text></Pressable><Pressable onPress={()=>chooseTool('text')} style={[styles.quickEditorTool,tool==='text'&&styles.quickEditorToolOn]}><Text style={[styles.quickEditorIcon,tool==='text'&&styles.quickEditorTextOn]}>T</Text><Text style={[styles.quickEditorLabel,tool==='text'&&styles.quickEditorTextOn]}>Texto</Text></Pressable><Pressable onPress={()=>{setTool('navigate');setNoteValue(activePhoto?.note||'');setNoteOpen(true)}} style={styles.quickEditorTool}><Text style={styles.quickEditorIcon}>✎</Text><Text style={styles.quickEditorLabel}>Nota</Text></Pressable><Pressable onPress={()=>addPhoto('camera')} style={styles.quickEditorTool}><Text style={styles.quickEditorIcon}>＋</Text><Text style={styles.quickEditorLabel}>Foto</Text></Pressable></View><View style={styles.quickEditorActions}><Pressable disabled={!marks.length&&!activePhoto.note} onPress={undoLast} style={[styles.quickEditorUndo,!marks.length&&!activePhoto.note&&{opacity:.35}]}><Text style={styles.quickEditorUndoText}>↶ Desfazer</Text></Pressable><Pressable onPress={()=>onSave?.(job)} style={styles.quickEditorSave}><Text style={styles.quickEditorSaveText}>✓ Salvar foto</Text></Pressable><Pressable onPress={()=>onFinish?.(job)} style={styles.quickEditorFinish}><Text style={styles.quickEditorFinishText}>Finalizar</Text></Pressable></View></View>
  <Modal visible={noteOpen} transparent animationType="fade" onRequestClose={()=>setNoteOpen(false)}><View style={styles.modalShade}><View style={styles.modalCard}><Text style={styles.modalTitle}>Nota da foto</Text><Text style={styles.modalText}>Registre detalhes importantes deste local.</Text><TextInput autoFocus multiline value={noteValue} onChangeText={setNoteValue} placeholder="Ex.: rodapé 10 cm, parede fora de esquadro..." placeholderTextColor="#9AA6B5" style={[styles.input,styles.quickNoteInput]}/><View style={{flexDirection:'row',gap:8,marginTop:14}}><Button secondary title="Cancelar" onPress={()=>setNoteOpen(false)}/><Button title="Salvar nota" onPress={()=>{updatePhoto({...activePhoto,note:noteValue.trim()});setNoteOpen(false)}}/></View></View></View></Modal>
  <Modal visible={textOpen} transparent animationType="fade" onRequestClose={()=>{setTextOpen(false);setTextPoint(null);setTool('navigate')}}><View style={styles.modalShade}><View style={styles.modalCard}><Text style={styles.modalTitle}>Adicionar texto</Text><Text style={styles.modalText}>Escreva uma identificação curta para este ponto da foto.</Text><TextInput autoFocus value={textValue} onChangeText={setTextValue} placeholder="Ex.: tomada 20 A" placeholderTextColor="#9AA6B5" style={[styles.input,{marginTop:14,fontSize:18,fontWeight:'700'}]} onSubmitEditing={confirmText}/><View style={{flexDirection:'row',gap:8,marginTop:14}}><Button secondary title="Cancelar" onPress={()=>{setTextOpen(false);setTextPoint(null);setTool('navigate')}}/><Button disabled={!textValue.trim()} title="Adicionar" onPress={confirmText}/></View></View></View></Modal>
  <Modal visible={!!pendingLine} transparent animationType="fade" onRequestClose={()=>{setPendingLine(null);setTool('navigate')}}><View style={styles.modalShade}><View style={styles.modalCard}><Text style={styles.modalTitle}>Qual é a medida?</Text><Text style={styles.modalText}>Digite o valor medido. Ex.: 2,47 m</Text><TextInput autoFocus value={measureValue} onChangeText={setMeasureValue} placeholder="2,47 m" placeholderTextColor="#9AA6B5" style={[styles.input,{marginTop:14,fontSize:24,fontWeight:'800'}]} onSubmitEditing={confirmMeasure}/><View style={{flexDirection:'row',gap:8,marginTop:14}}><Button secondary title="Cancelar" onPress={()=>{setPendingLine(null);setTool('navigate')}}/><Button disabled={!measureValue.trim()} title="Salvar medida" onPress={confirmMeasure}/></View></View></View></Modal>
  <Modal visible={!!pendingArea} transparent animationType="fade" onRequestClose={()=>{setPendingArea(null);setTool('navigate')}}><View style={styles.modalShade}><View style={styles.modalCard}><Text style={styles.modalTitle}>Qual é a área?</Text><Text style={styles.modalText}>Digite a área medida. Ex.: 4,20 m²</Text><TextInput autoFocus value={areaValue} onChangeText={setAreaValue} placeholder="4,20 m²" placeholderTextColor="#9AA6B5" style={[styles.input,{marginTop:14,fontSize:24,fontWeight:'800'}]} onSubmitEditing={confirmArea}/><View style={{flexDirection:'row',gap:8,marginTop:14}}><Button secondary title="Cancelar" onPress={()=>{setPendingArea(null);setTool('navigate')}}/><Button disabled={!areaValue.trim()} title="Salvar área" onPress={confirmArea}/></View></View></View></Modal></View>
}

export default function App(){
  const [ready,setReady]=useState(false),[screen,setScreen]=useState('welcome'),[projects,setProjects]=useState([]),[quickJobs,setQuickJobs]=useState([]),[activeProjectId,setActiveProjectId]=useState(null),[activeRoomId,setActiveRoomId]=useState(null),[draftMeta,setDraftMeta]=useState(null),[quickJob,setQuickJob]=useState(null),[gwSending,setGwSending]=useState(false),[gwLinking,setGwLinking]=useState(false),[gwLinkModal,setGwLinkModal]=useState({visible:false,targets:[],error:'',canCreate:false});
  useEffect(()=>{Promise.all([AsyncStorage.getItem(STORE_KEY),AsyncStorage.getItem('gw-medidas-quick-v1')]).then(([v,q])=>{if(v)try{setProjects(JSON.parse(v))}catch{};if(q)try{setQuickJobs(JSON.parse(q))}catch{};setReady(true)})},[]);
  const persist=async(next)=>{setProjects(next);await AsyncStorage.setItem(STORE_KEY,JSON.stringify(next))};
  const persistQuick=async(job)=>{const next=[job,...quickJobs.filter(q=>q.id!==job.id)];setQuickJobs(next);setQuickJob(job);await AsyncStorage.setItem('gw-medidas-quick-v1',JSON.stringify(next));return job};
  const project=projects.find(p=>p.id===activeProjectId), room=project?.rooms?.find(r=>r.id===activeRoomId);
  const updateRoom=async(nextRoom,announce=false)=>{const next=projects.map(p=>p.id!==activeProjectId?p:{...p,updatedAt:Date.now(),rooms:p.rooms.map(r=>r.id===nextRoom.id?nextRoom:r)});await persist(next);if(announce)Alert.alert('Salvo','Medição salva.');};
  const saveExit=async()=>{if(!room)return;await updateRoom(room,false);setScreen('project')};
  const finishRoom=async()=>{if(!room)return;await updateRoom(room,false);setScreen('project')};
  const finalizeExport=async(selection)=>{if(!project||!room)return;try{const html=pdfHtml(project,room,selection),fileName=`GW-Medidas-${safeFileName(project.client)}-${safeFileName(room.name)}.pdf`;if(Platform.OS==='web'){await exportWebPdf(html,fileName);return;}const {uri}=await Print.printToFileAsync({html});if(await Sharing.isAvailableAsync())await Sharing.shareAsync(uri,{mimeType:'application/pdf',UTI:'com.adobe.pdf',dialogTitle:`Exportar ${room.name}`});else Alert.alert('Arquivo criado','O PDF foi gerado com sucesso.');}catch(e){console.warn(e);Alert.alert('Exportar','Não foi possível gerar o arquivo agora.')}};
  const finalizeProjectExport=async(payload)=>{const rooms=Array.isArray(payload)?payload:payload?.rooms,wallsByRoom=Array.isArray(payload)?{}:(payload?.wallsByRoom||{});if(!project||!rooms?.length)return;try{const html=projectPdfHtml(project,rooms,wallsByRoom),fileName=`GW-Medidas-${safeFileName(project.client)}-${safeFileName(project.name)}.pdf`;if(Platform.OS==='web'){await exportWebPdf(html,fileName);return;}const {uri}=await Print.printToFileAsync({html});if(await Sharing.isAvailableAsync())await Sharing.shareAsync(uri,{mimeType:'application/pdf',UTI:'com.adobe.pdf',dialogTitle:`Exportar ${project.name}`});else Alert.alert('Arquivo criado','O PDF do projeto foi gerado com sucesso.');}catch(e){console.warn(e);Alert.alert('Exportar','Não foi possível gerar o projeto agora.')}};
  const [gwExporting,setGwExporting]=useState(false);
  const exportProjectDirectToGw=async(payload)=>{
    if(!project||!payload?.rooms?.length)return;
    if(!project.gwSourceType){Alert.alert('GW Assistente','Vincule esta medição a um orçamento/projeto do GW Assistente antes de enviar o exportar.');return;}
    if(Platform.OS!=='web'){Alert.alert('GW Assistente','Nesta etapa, o envio visual direto está sendo validado primeiro no computador.');return;}
    setGwExporting(true);
    try{
      await new Promise(resolve=>setTimeout(resolve,120));
      let node=payload.captureRef?.current;
      if(typeof document!=='undefined'){
        const domNode=document.querySelector('[data-gw-export-capture="project"]');
        if(domNode)node=domNode;
      }
      if(!node||typeof node.getBoundingClientRect!=='function')throw new Error('Não encontrei a pré-visualização do Exportar para capturar.');
      const html2canvas=(await import('html2canvas')).default;
      const canvas=await html2canvas(node,{scale:2,useCORS:true,allowTaint:false,backgroundColor:'#ffffff',logging:false,scrollX:0,scrollY:-window.scrollY});
      if(!canvas?.width||!canvas?.height)throw new Error('A captura do Exportar ficou vazia.');
      const maxWidth=1400;
      let outCanvas=canvas;
      if(canvas.width>maxWidth){
        const ratio=maxWidth/canvas.width;
        const resized=document.createElement('canvas');
        resized.width=Math.round(canvas.width*ratio);
        resized.height=Math.round(canvas.height*ratio);
        const ctx=resized.getContext('2d');
        ctx.fillStyle='#ffffff';ctx.fillRect(0,0,resized.width,resized.height);
        ctx.drawImage(canvas,0,0,resized.width,resized.height);
        outCanvas=resized;
      }
      let image=outCanvas.toDataURL('image/jpeg',0.9);
      if(image.length>7000000){
        const maxWidth2=1100,ratio=Math.min(1,maxWidth2/outCanvas.width);
        const resized=document.createElement('canvas');
        resized.width=Math.round(outCanvas.width*ratio);resized.height=Math.round(outCanvas.height*ratio);
        const ctx=resized.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,resized.width,resized.height);ctx.drawImage(outCanvas,0,0,resized.width,resized.height);
        outCanvas=resized;image=outCanvas.toDataURL('image/jpeg',0.82);
      }
      const result=await gwSendExportSnapshot(project,{image,width:outCanvas.width,height:outCanvas.height,rooms:payload.rooms.map(r=>r.name),createdAt:new Date().toISOString()});
      if(!result?.verified)throw new Error('O GW Assistente não confirmou o recebimento do arquivo.');
      const sentAtMs=Date.now();
      const next=projects.map(p=>p.id===project.id?{...p,gwExportLastSentAt:result.createdAt,gwExportLastSentAtMs:sentAtMs,updatedAt:sentAtMs}:p);
      await persist(next);
      if(typeof window!=='undefined'&&window.alert)window.alert('✓ Enviado ao GW Assistente\n\nO levantamento visual foi recebido e confirmado pelo GW Assistente.');
      else Alert.alert('✓ Enviado ao GW Assistente','O levantamento visual foi recebido e confirmado pelo GW Assistente.');
    }catch(e){
      console.warn('GW export send failed',e);
      const msg=e?.message||'Não foi possível enviar o Exportar projeto.';
      if(typeof window!=='undefined'&&window.alert)window.alert(`Falha no envio ao GW Assistente\n\n${msg}`);
      else Alert.alert('Falha no envio ao GW Assistente',msg);
    }finally{setGwExporting(false)}
  };
  const deleteProject=id=>confirmDelete('Excluir projeto','Excluir este projeto e todos os ambientes?',async()=>{await persist(projects.filter(p=>p.id!==id));if(activeProjectId===id){setActiveProjectId(null);setActiveRoomId(null);setScreen('home')}});
  const deleteRoom=id=>confirmDelete('Excluir ambiente','Excluir este ambiente e todas as medidas dele?',async()=>{const next=projects.map(p=>p.id!==activeProjectId?p:{...p,updatedAt:Date.now(),rooms:p.rooms.filter(r=>r.id!==id)});await persist(next);if(activeRoomId===id)setActiveRoomId(null)});
  const begin=async meta=>{const count=clamp(Number(meta?.suggestedWallCount||4),1,4);const r={id:uid(),name:meta.room,roomType:meta.roomType||'',wallCount:count,lengths:[3.20,2.80,3.20,2.80].slice(0,count),height:2.65,elements:[],photos:[],notes:'',createdAt:Date.now()};let pid=meta.projectId,next;if(pid){next=projects.map(p=>p.id===pid?{...p,updatedAt:Date.now(),rooms:[...(p.rooms||[]),r]}:p)}else{pid=uid();next=[...projects,{id:pid,client:meta.client,name:meta.project,rooms:[r],createdAt:Date.now(),updatedAt:Date.now()}]};await persist(next);setDraftMeta(meta);setActiveProjectId(pid);setActiveRoomId(r.id);setScreen('measure')};
  const createRoom=async count=>{const r={id:uid(),name:draftMeta.room,wallCount:count,lengths:[3.20,2.80,3.20,2.80].slice(0,count),height:2.65,elements:[],photos:[],notes:'',createdAt:Date.now()};let pid=draftMeta.projectId,next;if(pid){next=projects.map(p=>p.id===pid?{...p,updatedAt:Date.now(),rooms:[...p.rooms,r]}:p)}else{pid=uid();next=[...projects,{id:pid,client:draftMeta.client,name:draftMeta.project,rooms:[r],createdAt:Date.now(),updatedAt:Date.now()}]};await persist(next);setActiveProjectId(pid);setActiveRoomId(r.id);setScreen('measure')};
  const newRoomForProject=p=>{setActiveRoomId(null);setDraftMeta({client:p.client,project:p.name,room:'',projectId:p.id});setScreen('newRoomName')};
  const sendCurrentToGw=async()=>{
    if(!project||!['orcamento','projeto'].includes(project.gwSourceType))return;
    if(!(project.rooms||[]).length){Alert.alert('GW Assistente','Crie pelo menos um ambiente antes de enviar.');return;}
    setGwSending(true);
    try{
      const isBudget=project.gwSourceType==='orcamento';
      const result=isBudget?await gwSendMeasurementToBudget(project):await gwSendMeasurementToProject(project);
      const pushedAt=result?.syncedAt||new Date().toISOString();
      const next=projects.map(p=>p.id===project.id?{...p,gwLastPushAt:pushedAt,gwLastPushRooms:result?.environments||0,updatedAt:Date.now()}:p);
      await persist(next);
      Alert.alert('Enviado ao GW Assistente',`${result?.environments||0} ambiente(s) enviado(s) para ${isBudget?'o orçamento':'o projeto'}. As fotos ainda não são transferidas nesta etapa; enviamos a medição técnica e a quantidade de fotos.`);
    }catch(e){console.warn(e);Alert.alert('Não foi possível enviar',e?.message||'Tente novamente. Nenhum dado local foi perdido.')}finally{setGwSending(false)}
  };
  const openLinkCurrentToGw=async()=>{
    if(!project||project.gwSourceType)return;
    setGwLinking(true);
    setGwLinkModal({visible:true,targets:[],error:'',canCreate:true});
    try{
      const payload=await gwLoadWorkspaceProjects();
      const cmap=new Map();
      (payload.clientes||[]).forEach(c=>{for(const k of [c.id,c.__sourceId,c.codigo,c.uuid])if(k!=null)cmap.set(String(k),c)});
      const cname=item=>item?.cliente||cmap.get(String(item?.clienteId??item?.cliente_id??''))?.nome||cmap.get(String(item?.clienteId??item?.cliente_id??''))?.name||'Sem cliente';
      const budgets=(payload.orcamentos||[]).map((b,i)=>({type:'orcamento',id:String(b?.id??b?.__sourceId??`b-${i}`),name:b?.projeto||b?.nome||b?.projetosOrcamento?.[0]?.nome||`Orçamento ${i+1}`,client:cname(b),status:b?.status||'Rascunho',companyId:payload.companyId}));
      const projectsGw=(payload.projetos||[]).map((g,i)=>({type:'projeto',id:String(g?.id??g?.__sourceId??`p-${i}`),name:g?.nome||g?.projeto||g?.ambiente||`Projeto ${i+1}`,client:cname(g),status:'Projeto aprovado',companyId:payload.companyId}));
      const norm=v=>String(v||'').trim().toLowerCase();
      const all=[...budgets,...projectsGw].sort((a,b)=>Number(norm(b.client)===norm(project.client))-Number(norm(a.client)===norm(project.client)));
      setGwLinkModal({visible:true,targets:all,error:'',canCreate:true});
    }catch(e){setGwLinkModal({visible:true,targets:[],error:e?.message||'Não consegui carregar os vínculos do GW Assistente.',canCreate:true})}finally{setGwLinking(false)}
  };
  const linkCurrentToGw=async target=>{
    if(!project||!target)return;
    const next=projects.map(p=>p.id!==project.id?p:{...p,client:target.client||p.client,name:target.name||p.name,gwImported:true,gwSourceType:target.type,gwBudgetId:target.type==='orcamento'?target.id:null,gwProjectId:target.type==='projeto'?target.id:null,gwCompanyId:target.companyId,gwLinkedFromLocal:true,gwSyncAt:Date.now(),updatedAt:Date.now()});
    await persist(next);
    setGwLinkModal({visible:false,targets:[],error:''});
    Alert.alert('Vínculo criado',`Esta medição agora está vinculada a ${target.type==='orcamento'?'um orçamento':'um projeto'} do GW Assistente.`);
  };
  const createBudgetFromLocal=async()=>{
    if(!project||project.gwSourceType)return;
    if(!(project.rooms||[]).length){Alert.alert('GW Assistente','Crie pelo menos um ambiente antes de enviar.');return;}
    setGwLinking(true);
    try{
      const result=await gwCreateBudgetFromLocalMeasurement(project);
      const next=projects.map(p=>p.id!==project.id?p:{...p,gwImported:true,gwSourceType:'orcamento',gwBudgetId:result.budgetId,gwProjectId:null,gwCompanyId:result.companyId,gwLinkedFromLocal:true,gwSyncAt:Date.now(),gwLastPushAt:result.syncedAt,gwLastPushRooms:result.environments||0,updatedAt:Date.now()});
      await persist(next);
      setGwLinkModal({visible:false,targets:[],error:'',canCreate:false});
      Alert.alert('Enviado ao GW Assistente',`O cliente ${result.clientCreated?'foi criado':'já existia'} no GW Assistente. Um novo orçamento foi criado e recebeu ${result.environments||0} ambiente(s) do levantamento.`);
    }catch(e){console.warn(e);setGwLinkModal(m=>({...m,error:e?.message||'Não consegui criar o orçamento no GW Assistente.'}));}finally{setGwLinking(false)}
  };
  if(!ready)return <AppFrame><View style={styles.loading}><Text style={styles.brand}><Text style={{color:INK}}>GW</Text> <Text style={{color:BLUE}}>MEDIDAS</Text></Text></View></AppFrame>;
  let content;
  if(screen==='welcome')content=<Welcome onStart={()=>setScreen('home')}/>;
  else if(screen==='modeHome')content=<MeasurementModeHome onBack={()=>setScreen('welcome')} onQuick={()=>setScreen('quickForm')} onComplete={()=>setScreen('home')}/>;
  else if(screen==='quickForm')content=<QuickMeasurementForm onBack={()=>setScreen('home')} onContinue={j=>{setQuickJob(j);setScreen('quickPhoto')}}/>;
  else if(screen==='quickPhoto')content=<QuickPhotoMeasure job={quickJob} onBack={()=>setScreen('home')} onUpdate={setQuickJob} onSave={async (j,silent=false)=>{await persistQuick(j);if(!silent)Alert.alert('Salvo','Foto salva. Você pode continuar medindo ou adicionar outra foto.')}} onFinish={async j=>{await persistQuick(j);setScreen('home')}}/>;
  else if(screen==='home')content=<Home onQuick={()=>{setQuickJob(null);setScreen('quickForm')}} onNew={()=>setScreen('new')} onProjects={()=>setScreen('projectsLibrary')} onClients={()=>setScreen('clients')} onHelp={()=>setScreen('help')} onMore={()=>setScreen('more')}/>;
  else if(screen==='projectsLibrary')content=<ProjectsLibrary projects={projects} quickJobs={quickJobs} onBack={()=>setScreen('home')} onHome={()=>setScreen('home')} onOpenQuick={id=>{const q=quickJobs.find(x=>x.id===id);if(q){setQuickJob(q);setScreen('quickPhoto')}}} onOpen={id=>{setActiveProjectId(id);setScreen('project')}} onDelete={deleteProject} onClients={()=>setScreen('clients')} onMore={()=>setScreen('more')}/>;
  else if(screen==='clients')content=<ClientsScreen projects={projects} quickJobs={quickJobs} onBack={()=>setScreen('home')}/>;
  else if(screen==='help')content=<HelpScreen onBack={()=>setScreen('home')}/>;
  else if(screen==='more')content=<MoreScreen onBack={()=>setScreen('home')} onNew={()=>setScreen('new')} onIntegration={()=>setScreen('gwIntegration')}/>;
  else if(screen==='gwIntegration')content=<GwIntegrationScreen projects={projects} onBack={()=>setScreen('more')} onSynced={persist}/>;
  else if(screen==='new')content=<NewMeasurement projects={projects} onBack={()=>setScreen('home')} onContinue={begin}/>;
  else if(screen==='project')content=<ProjectScreen project={project} onBack={()=>setScreen('projectsLibrary')} onOpenRoom={id=>{setActiveRoomId(id);setScreen('measure')}} onNewRoom={()=>newRoomForProject(project)} onDeleteRoom={deleteRoom} onDeleteProject={()=>deleteProject(project.id)} onExportProject={()=>setScreen('projectExport')} onSendToGw={sendCurrentToGw} onLinkToGw={openLinkCurrentToGw} gwSending={gwSending} gwLinking={gwLinking}/>;
  else if(screen==='newRoomName')content=<NewRoomName meta={draftMeta} onBack={()=>setScreen('project')} onContinue={m=>{setDraftMeta({...draftMeta,room:m});setScreen('measure')}}/>;
  else if(screen==='measure')content=<PlanEditor project={project} room={room} draftMeta={draftMeta} onBack={()=>room?setScreen('project'):(draftMeta?.projectId?setScreen('project'):setScreen('new'))} onSave={updateRoom} onSaveExit={saveExit} onChooseCount={createRoom} onPhotos={()=>setScreen('photos')} onFinish={finishRoom} onExportPreview={()=>setScreen('export')}/>;
  else if(screen==='projectExport')content=<ProjectExportPreview project={project} onBack={()=>setScreen('project')} onExport={finalizeProjectExport} onExportGw={exportProjectDirectToGw} gwExporting={gwExporting}/>;
  else if(screen==='export')content=<ExportPreview project={project} room={room} onBack={()=>setScreen('measure')} onExport={finalizeExport}/>;
  else if(screen==='photos')content=<Photos room={room} onBack={()=>setScreen('measure')} onUpdateRoom={updateRoom}/>;
  return <GestureHandlerRootView style={{flex:1}}><AppFrame>{content}<Modal visible={gwLinkModal.visible} transparent animationType="fade" onRequestClose={()=>setGwLinkModal({visible:false,targets:[],error:''})}><View style={styles.modalShade}><View style={[styles.modalCard,{maxHeight:'78%'}]}><Text style={styles.modalTitle}>Enviar ao GW Assistente</Text><Text style={styles.modalText}>Para uma medição criada aqui, você pode criar um novo orçamento no GW Assistente ou vinculá-la a algo que já existe.</Text>{gwLinkModal.canCreate?<Pressable disabled={gwLinking} onPress={createBudgetFromLocal} style={[styles.gwSendBtn,{marginTop:14,opacity:gwLinking?.6:1}]}><Text style={styles.gwSendBtnText}>{gwLinking?'Enviando...':`+ Criar orçamento no GW para ${project?.client||'este cliente'}`}</Text></Pressable>:null}{gwLinkModal.targets?.length?<Text style={[styles.modalText,{marginTop:14,fontWeight:'800',color:INK}]}>Ou vincular a um orçamento/projeto existente:</Text>:null}{gwLinkModal.error?<Text style={[styles.modalText,{color:'#C62828',marginTop:10}]}>{gwLinkModal.error}</Text>:null}<ScrollView style={{marginTop:10}}>{gwLinkModal.targets.map(t=><Pressable key={`${t.type}-${t.id}`} onPress={()=>linkCurrentToGw(t)} style={styles.linkTargetCard}><Text style={styles.linkTargetTitle}>{t.name}</Text><Text style={styles.linkTargetMeta}>{t.client} · {t.type==='orcamento'?`Orçamento · ${t.status}`:'Projeto aprovado'}</Text></Pressable>)}</ScrollView><Pressable onPress={()=>setGwLinkModal({visible:false,targets:[],error:'',canCreate:false})} style={[styles.gwSendBtn,{marginTop:12,backgroundColor:'#EEF2F6'}]}><Text style={[styles.gwSendBtnText,{color:INK}]}>Cancelar</Text></Pressable></View></View></Modal></AppFrame></GestureHandlerRootView>;
}
function NewRoomName({meta,onBack,onContinue}){const [room,setRoom]=useState('');return <View style={styles.screen}><Header title="Novo ambiente" subtitle={`${meta.client} · ${meta.project}`} onBack={onBack}/><View style={styles.pad}><Field label="Ambiente" value={room} onChangeText={setRoom} placeholder="Ex.: Banheiro"/><Button disabled={!room.trim()} title="Continuar" onPress={()=>onContinue(room.trim())}/></View></View>}

const styles=StyleSheet.create({
  webOuter:{flex:1,backgroundColor:Platform.OS==='web'?'#DDE3EA':BG,alignItems:Platform.OS==='web'?'center':'stretch'},appFrame:{flex:1,width:'100%',maxWidth:Platform.OS==='web'?440:undefined,backgroundColor:BG,overflow:'hidden'},screen:{flex:1,backgroundColor:BG},loading:{flex:1,alignItems:'center',justifyContent:'center',backgroundColor:BG},pad:{padding:18,gap:15},modalShade:{flex:1,backgroundColor:'rgba(16,24,32,.45)',alignItems:'center',justifyContent:'center',padding:20},modalCard:{width:'100%',maxWidth:400,backgroundColor:WHITE,borderRadius:18,padding:18},modalTitle:{fontSize:20,fontWeight:'900',color:INK},modalText:{fontSize:12,color:MUTED,lineHeight:17,marginTop:4},linkTargetCard:{borderWidth:1,borderColor:BORDER,borderRadius:12,padding:13,marginBottom:8,backgroundColor:'#FFF'},linkTargetTitle:{fontSize:14,fontWeight:'900',color:INK},linkTargetMeta:{fontSize:11,color:MUTED,marginTop:3},
  header:{backgroundColor:WHITE,paddingTop:Platform.OS==='ios'?58:22,paddingHorizontal:18,paddingBottom:18,borderBottomWidth:1,borderBottomColor:'#E5EBF1',flexDirection:'row',alignItems:'flex-end'},headerTitle:{color:INK,fontSize:30,lineHeight:36,fontWeight:'800',letterSpacing:-.8,marginTop:5},headerSub:{color:MUTED,fontSize:15,lineHeight:21,marginTop:4},back:{color:BLUE,fontSize:17,fontWeight:'750'},
  btn:{flex:1,minHeight:54,borderRadius:16,backgroundColor:BLUE,alignItems:'center',justifyContent:'center',paddingHorizontal:18},btnSecondary:{backgroundColor:WHITE,borderWidth:1.5,borderColor:BORDER},btnCompact:{flex:0,minHeight:50,paddingHorizontal:28},btnText:{color:WHITE,fontSize:17,fontWeight:'800'},btnTextSecondary:{color:INK},
  welcome:{flex:1,paddingHorizontal:24,paddingTop:42,backgroundColor:'#0B1118'},brand:{fontSize:28,fontWeight:'900',letterSpacing:.4},welcomeTitle:{color:WHITE,fontSize:34,lineHeight:41,fontWeight:'500',letterSpacing:-1.3,marginTop:30,maxWidth:350},welcomeSub:{color:'#B6C0CD',fontSize:18,marginTop:16},
  sectionKicker:{color:BLUE,fontSize:11,fontWeight:'900',letterSpacing:1.1},emptyHome:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:22,padding:24,alignItems:'center'},emptyHomeIcon:{fontSize:38},emptyHomeTitle:{color:INK,fontSize:20,fontWeight:'800',marginTop:8},emptyHomeText:{color:MUTED,fontSize:14,lineHeight:20,textAlign:'center',marginTop:5},
  projectCard:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:20,padding:15,flexDirection:'row',alignItems:'center',gap:12},
  gwSendCard:{marginHorizontal:0,marginBottom:14,borderRadius:16,borderWidth:1,borderColor:'#BFD9FA',backgroundColor:'#F5F9FF',padding:13,gap:10},gwSendTitle:{fontSize:14,fontWeight:'900',color:INK},gwSendText:{fontSize:11.5,lineHeight:16,color:MUTED,marginTop:3},gwSendLast:{fontSize:10.5,color:'#178653',fontWeight:'800',marginTop:5},gwSendBtn:{height:44,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},gwSendBtnText:{color:WHITE,fontSize:14,fontWeight:'900'},
homeList:{paddingHorizontal:14,paddingTop:12,paddingBottom:18,gap:8},homeFooter:{paddingHorizontal:14,paddingTop:8,paddingBottom:Platform.OS==='ios'?28:14,backgroundColor:BG,borderTopWidth:1,borderTopColor:'#E2E8F0'},newMeasureBtn:{height:48,borderRadius:14,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},newMeasureText:{color:WHITE,fontSize:16,fontWeight:'850'},projectCardCompact:{minHeight:76,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:16,flexDirection:'row',alignItems:'stretch',overflow:'hidden'},projectOpenArea:{flex:1,flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:11,paddingVertical:9},projectIconSmall:{width:36,height:36,borderRadius:11,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},projectTitleSmall:{color:INK,fontSize:16,fontWeight:'850'},projectMetaSmall:{color:MUTED,fontSize:11.5,marginTop:1},projectRoomsSmall:{color:'#43536A',fontSize:11,marginTop:2},chevSmall:{color:BLUE,fontSize:25},deleteIconBtn:{width:44,alignItems:'center',justifyContent:'center',borderLeftWidth:1,borderLeftColor:'#EDF1F5'},deleteIconText:{fontSize:16},projectIcon:{width:48,height:48,borderRadius:16,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},projectTitle:{color:INK,fontSize:19,fontWeight:'800'},projectMeta:{color:MUTED,fontSize:13.5,marginTop:2},projectRooms:{color:'#43536A',fontSize:12.5,marginTop:4},chev:{color:BLUE,fontSize:32,fontWeight:'300'},
  label:{color:'#334155',fontSize:14,fontWeight:'750',marginBottom:6},input:{minHeight:56,borderWidth:1.5,borderColor:BORDER,borderRadius:16,backgroundColor:WHITE,paddingHorizontal:14,fontSize:17,color:INK},infoSoft:{padding:15,borderRadius:17,backgroundColor:BLUE_SOFT},infoSoftTitle:{color:BLUE,fontWeight:'850',fontSize:15},infoSoftText:{color:'#46586D',fontSize:13.5,lineHeight:19,marginTop:3},existingChip:{paddingHorizontal:12,paddingVertical:10,borderRadius:12,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE},existingChipOn:{borderColor:BLUE,backgroundColor:BLUE_SOFT},existingChipText:{color:'#475569',fontWeight:'750',fontSize:13},orText:{textAlign:'center',color:MUTED,fontSize:12},
  wallChoiceWrap:{padding:18,gap:14},wallChoiceTitle:{fontSize:22,fontWeight:'800',color:INK,lineHeight:28},floorPreview:{height:220,borderRadius:22,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE,overflow:'hidden',alignItems:'center',justifyContent:'center'},floorPreviewText:{color:'#9AA6B5',fontSize:13,fontWeight:'700',backgroundColor:'rgba(255,255,255,.85)',paddingHorizontal:10,paddingVertical:6,borderRadius:10},wallCountRow:{flexDirection:'row',gap:8},wallCountCard:{flex:1,minHeight:92,borderRadius:17,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center'},wallShape:{fontSize:31,color:BLUE,fontWeight:'500'},wallCountText:{fontSize:11.5,color:INK,fontWeight:'800',marginTop:5},wallChoiceHint:{color:MUTED,fontSize:13,lineHeight:18,textAlign:'center'},
  editorScreen:{flex:1,backgroundColor:'#EDF2F7'},editorTop:{paddingTop:Platform.OS==='ios'?54:16,paddingHorizontal:14,paddingBottom:12,backgroundColor:WHITE,borderBottomWidth:1,borderBottomColor:'#E5EBF1',flexDirection:'row',alignItems:'center'},editorTitle:{color:INK,fontSize:23,fontWeight:'850'},editorSub:{color:MUTED,fontSize:12.5,marginTop:2},saveBtn:{minHeight:40,paddingHorizontal:13,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},saveBtnText:{color:WHITE,fontSize:14,fontWeight:'850'},toolBar:{minHeight:42,paddingHorizontal:14,flexDirection:'row',alignItems:'center',gap:8},toolLabel:{flex:1,color:MUTED,fontSize:12},zoomBadge:{color:'#475569',fontSize:12,fontWeight:'800',backgroundColor:WHITE,paddingHorizontal:8,paddingVertical:5,borderRadius:9},
  planCanvas:{alignSelf:'center',overflow:'hidden',backgroundColor:WHITE,borderRadius:20,borderWidth:1,borderColor:BORDER},planWordSymbol:{height:28,borderRadius:6,borderWidth:1.5,borderColor:INK,backgroundColor:WHITE,alignItems:'center',justifyContent:'center',paddingHorizontal:4},planWordSymbolSelected:{borderColor:BLUE,borderWidth:2},planWordText:{fontSize:9,fontWeight:'850',color:INK},selectedCard:{margin:11,marginTop:9,padding:10,backgroundColor:WHITE,borderRadius:16,borderWidth:1,borderColor:BORDER,flexDirection:'row',alignItems:'center',gap:6},selectedKicker:{color:BLUE,fontSize:9,fontWeight:'900',letterSpacing:.8},selectedTitle:{color:INK,fontSize:15,fontWeight:'850',marginTop:2},miniBtn:{minWidth:44,minHeight:38,paddingHorizontal:9,borderRadius:11,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center'},miniBtnPrimary:{backgroundColor:BLUE,borderColor:BLUE},miniBtnText:{color:INK,fontSize:11.5,fontWeight:'850'},categoryDock:{paddingHorizontal:11,paddingBottom:11,flexDirection:'row',gap:8},categoryBtn:{flex:1,minHeight:62,borderRadius:15,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center',paddingHorizontal:4},categoryIcon:{color:BLUE,fontSize:20,fontWeight:'800'},categoryText:{color:'#3F4D5F',fontSize:11,fontWeight:'850',marginTop:3,textAlign:'center'},
  modalBackdrop:{flex:1,backgroundColor:'rgba(15,24,32,.42)',alignItems:'center',justifyContent:'center',padding:20},modalCard:{width:'100%',maxWidth:420,borderRadius:24,backgroundColor:WHITE,padding:20,gap:12},modalTitle:{color:INK,fontSize:22,fontWeight:'850'},bigInput:{minHeight:62,borderWidth:1.5,borderColor:BORDER,borderRadius:15,paddingHorizontal:15,color:INK,fontSize:29,fontWeight:'700'},sheetBackdrop:{flex:1,backgroundColor:'rgba(15,24,32,.35)',justifyContent:'flex-end'},sheet:{backgroundColor:WHITE,paddingHorizontal:17,paddingTop:10,paddingBottom:Platform.OS==='ios'?30:18,borderTopLeftRadius:27,borderTopRightRadius:27,maxHeight:'78%'},sheetHandle:{width:42,height:5,borderRadius:3,backgroundColor:'#CBD5E1',alignSelf:'center',marginBottom:13},groupTab:{paddingHorizontal:11,paddingVertical:8,borderRadius:11,backgroundColor:'#F1F5F9'},groupTabOn:{backgroundColor:BLUE_SOFT},groupTabText:{color:'#475569',fontSize:12,fontWeight:'800'},groupTabTextOn:{color:BLUE},iconGrid:{flexDirection:'row',flexWrap:'wrap',gap:9,paddingBottom:8},iconChoice:{width:'31%',minHeight:92,borderRadius:15,borderWidth:1,borderColor:BORDER,backgroundColor:'#FAFCFE',alignItems:'center',justifyContent:'center',padding:7},itemIcon:{backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},iconChoiceText:{color:INK,fontSize:11.5,fontWeight:'750',textAlign:'center',marginTop:6},
  elevCanvas:{alignSelf:'center',overflow:'hidden',backgroundColor:'#E5ECF3',borderRadius:20,borderWidth:1,borderColor:BORDER},wallFace:{position:'absolute',backgroundColor:WHITE,borderWidth:5,borderColor:INK},objTouch:{position:'absolute',zIndex:20},objVisual:{alignItems:'center',justifyContent:'center',borderWidth:1.3,borderColor:'#7B8792',backgroundColor:WHITE,borderRadius:2},objOpening:{backgroundColor:'rgba(234,243,255,.72)',borderRadius:1,borderStyle:'solid'},objEquip:{backgroundColor:'rgba(231,236,239,.82)',borderStyle:'solid',borderColor:'#77838E'},objSelected:{borderWidth:2.4,borderColor:BLUE},objDimLabel:{position:'absolute',bottom:0,alignSelf:'center',backgroundColor:'rgba(255,255,255,.92)',borderRadius:5,paddingHorizontal:4,paddingVertical:1},objDimText:{fontSize:8,color:'#334155',fontWeight:'800'},wallWidthCota:{position:'absolute',height:18,alignItems:'center',justifyContent:'center',zIndex:40},wallHeightCota:{position:'absolute',width:42,alignItems:'center',justifyContent:'center',zIndex:40},wallCotaText:{fontSize:9,color:BLUE,fontWeight:'900',backgroundColor:'rgba(255,255,255,.9)',paddingHorizontal:3,borderRadius:4},cotaBar:{marginHorizontal:12,marginTop:8,minHeight:52,borderRadius:15,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,paddingHorizontal:9,flexDirection:'row',flexWrap:'wrap',alignItems:'center',justifyContent:'space-around',gap:5},cotaText:{color:BLUE,fontSize:12.5,fontWeight:'850'},cotaName:{color:INK,fontSize:12.5,fontWeight:'850',backgroundColor:'#F1F5F9',paddingHorizontal:8,paddingVertical:5,borderRadius:8},selectHint:{color:MUTED,fontSize:12.5,textAlign:'center',marginTop:11},elevActions:{padding:12,flexDirection:'row',gap:9},
  formHint:{color:MUTED,fontSize:13,marginTop:2},formSection:{color:'#334155',fontSize:12,fontWeight:'900',marginTop:14,marginBottom:8,textTransform:'uppercase',letterSpacing:.5},twoCols:{flexDirection:'row',flexWrap:'wrap',gap:9},miniField:{width:'48%'},miniLabel:{color:'#475569',fontSize:12,fontWeight:'750',marginBottom:5},miniInput:{minHeight:48,borderWidth:1.5,borderColor:BORDER,borderRadius:13,backgroundColor:WHITE,paddingHorizontal:11,color:INK,fontSize:17},readOnly:{width:'48%',minHeight:48,borderRadius:13,backgroundColor:'#F1F5F9',padding:9},readOnlyText:{color:INK,fontSize:16,fontWeight:'800'},
  projectHero:{padding:18,borderRadius:20,backgroundColor:'#0F1720'},projectHeroTitle:{color:WHITE,fontSize:23,fontWeight:'850'},projectHeroSub:{color:'#B6C0CD',fontSize:14,marginTop:4},roomCard:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:18,padding:14,flexDirection:'row',alignItems:'center',gap:11},roomBadge:{width:44,height:44,borderRadius:14,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},roomTitle:{color:INK,fontSize:18,fontWeight:'800'},roomMeta:{color:MUTED,fontSize:12.5,marginTop:3},hubCard:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:20,padding:16,flexDirection:'row',alignItems:'center',gap:12},hubIcon:{width:48,height:48,borderRadius:15,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},hubTitle:{color:INK,fontSize:19,fontWeight:'800'},hubText:{color:MUTED,fontSize:13.5,marginTop:3},summaryBox:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:20,padding:17,gap:8},summaryLine:{color:'#405066',fontSize:14,fontWeight:'700'},

  chooseOverlay:{flex:1,alignItems:'center',justifyContent:'center'},wallCountRowEditor:{paddingHorizontal:12,paddingTop:10,flexDirection:'row',gap:7},wallCountCardEditor:{flex:1,minHeight:78,borderRadius:15,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center'},
  viewSwitch:{paddingHorizontal:11,paddingVertical:6,borderRadius:9,backgroundColor:BLUE_SOFT},viewSwitchText:{color:BLUE,fontWeight:'850',fontSize:12},viewsLabel:{color:'#475569',fontSize:11,fontWeight:'850',textTransform:'uppercase',letterSpacing:.5},viewSegments:{flex:1,flexDirection:'row',backgroundColor:'#E2E8F0',borderRadius:10,padding:2,gap:2},viewSegment:{flex:1,minHeight:29,alignItems:'center',justifyContent:'center',borderRadius:8},viewSegmentOn:{backgroundColor:WHITE,shadowColor:'#000',shadowOpacity:.08,shadowRadius:3,shadowOffset:{width:0,height:1}},viewSegmentText:{fontSize:10.5,fontWeight:'800',color:'#64748B'},viewSegmentTextOn:{color:BLUE},wallViewSelector:{paddingHorizontal:11,paddingTop:7,paddingBottom:7,backgroundColor:'#EEF3F8',borderBottomWidth:1,borderBottomColor:BORDER},wallViewLabel:{fontSize:9.5,fontWeight:'900',color:'#64748B',letterSpacing:.7,marginBottom:6},wallViewTabs:{flexDirection:'row',gap:6},wallViewTab:{flex:1,minHeight:36,borderRadius:10,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE,alignItems:'center',justifyContent:'center'},wallViewTabOn:{backgroundColor:BLUE,borderColor:BLUE},wallViewTabText:{fontSize:10,fontWeight:'850',color:'#475569'},wallViewTabTextOn:{color:WHITE},wallCountRowCompact:{paddingHorizontal:11,paddingBottom:9,flexDirection:'row',gap:7},wallCountCompact:{flex:1,minHeight:50,borderRadius:13,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE,alignItems:'center',justifyContent:'center'},wallCountCompactOn:{backgroundColor:BLUE,borderColor:BLUE},wallCompactShape:{fontSize:16,color:BLUE,fontWeight:'850'},wallCompactText:{fontSize:9.4,color:MUTED,fontWeight:'850',marginTop:2},
  finishDock:{paddingHorizontal:11,paddingBottom:10,flexDirection:'row',gap:7},finishBtn:{flex:1,minWidth:0,minHeight:58,borderRadius:14,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center',paddingHorizontal:2},finishBtnPrimary:{backgroundColor:BLUE,borderColor:BLUE},finishIcon:{fontSize:18,color:BLUE,fontWeight:'900'},finishText:{fontSize:10.2,fontWeight:'850',color:INK,marginTop:3,textAlign:'center'},adjustRow:{paddingHorizontal:11,paddingBottom:9,flexDirection:'row',alignItems:'center',gap:8},
  planObjTouch:{position:'absolute',width:50,height:50,alignItems:'center',justifyContent:'center',zIndex:30},planObj:{width:32,height:32,borderRadius:10,backgroundColor:WHITE,borderWidth:2,borderColor:BLUE,alignItems:'center',justifyContent:'center'},planOpeningObj:{height:24,borderRadius:4,backgroundColor:WHITE},planStructureObj:{height:34,borderRadius:5,backgroundColor:'#F1F5F9'},planEquipObj:{height:30,borderRadius:6,backgroundColor:'#F7FAFC'},planObjSelected:{borderColor:'#FF9F0A',borderWidth:3,transform:[{scale:1.08}]},quickActions:{paddingHorizontal:11,paddingBottom:12,flexDirection:'row',alignItems:'center',gap:9},quickAction:{minWidth:82,minHeight:42,borderRadius:12,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:5},quickActionIcon:{fontSize:16},quickActionText:{fontSize:11.5,fontWeight:'850',color:INK},quickDelete:{minWidth:72,minHeight:42,borderRadius:12,backgroundColor:'#FFF1F2',borderWidth:1,borderColor:'#FECDD3',alignItems:'center',justifyContent:'center'},quickDeleteText:{fontSize:11.5,fontWeight:'850',color:'#B42318'},deletePill:{paddingHorizontal:10,paddingVertical:8,borderRadius:10,backgroundColor:'#FFF1F2'},deletePillText:{fontSize:11.5,fontWeight:'850',color:'#B42318'},deleteHeaderBtn:{paddingHorizontal:11,paddingVertical:8,borderRadius:10,backgroundColor:'#FFF1F2'},deleteHeaderText:{fontSize:12,fontWeight:'850',color:'#B42318'},projectList:{padding:14,gap:8,paddingBottom:20},roomCardCompact:{minHeight:66,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:15,flexDirection:'row',alignItems:'stretch',overflow:'hidden'},roomBadgeSmall:{width:34,height:34,borderRadius:10,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},roomTitleSmall:{color:INK,fontSize:16,fontWeight:'850'},dragHint:{flex:1,color:MUTED,fontSize:11,lineHeight:15},
  notesInput:{minHeight:150,borderWidth:1.5,borderColor:BORDER,borderRadius:14,padding:12,textAlignVertical:'top',fontSize:15,color:INK,backgroundColor:WHITE,marginVertical:12},summaryPage:{padding:14,gap:10,paddingBottom:30},summaryTechBox:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:16,padding:14,gap:8},summaryTechRow:{flexDirection:'row',justifyContent:'space-between',gap:10,paddingVertical:7,borderBottomWidth:1,borderBottomColor:'#EDF1F5'},summaryTechItem:{paddingVertical:7,borderBottomWidth:1,borderBottomColor:'#EDF1F5'},summaryTechStrong:{fontSize:13,fontWeight:'850',color:INK},summaryTechValue:{fontSize:12,color:MUTED,marginTop:2},summaryNotes:{fontSize:13,lineHeight:19,color:'#334155'},photoGrid:{flexDirection:'row',flexWrap:'wrap',gap:9},photoCard:{width:'48%',aspectRatio:1,borderRadius:16,overflow:'hidden',backgroundColor:'#E2E8F0'},photo:{width:'100%',height:'100%'},photoDelete:{position:'absolute',right:6,top:6,width:30,height:30,borderRadius:15,backgroundColor:'rgba(255,255,255,.92)',alignItems:'center',justifyContent:'center'},emptyPhotos:{padding:22,alignItems:'center'},

  welcomeGlow:{position:'absolute',left:-70,right:-70,top:-100,height:520,backgroundColor:'#202832',opacity:.38,borderBottomLeftRadius:220,borderBottomRightRadius:220},welcomeLogoWrap:{marginTop:Platform.OS==='ios'?86:58,alignItems:'center'},welcomeGW:{color:WHITE,fontSize:50,fontWeight:'950',fontStyle:'italic',letterSpacing:-4},welcomeMedidas:{color:'#4AA0FF',fontSize:17,fontWeight:'700',letterSpacing:8,marginTop:-4,marginLeft:8},welcomePromise:{color:WHITE,fontSize:18,lineHeight:25,textAlign:'center',fontWeight:'650',marginTop:28},welcomeActions:{marginTop:78,gap:12},welcomePrimary:{height:52,borderRadius:26,backgroundColor:'#1682FF',alignItems:'center',justifyContent:'center'},welcomePrimaryText:{color:WHITE,fontSize:16,fontWeight:'850'},welcomeSecondary:{height:52,borderRadius:26,borderWidth:1.5,borderColor:'rgba(255,255,255,.82)',alignItems:'center',justifyContent:'center'},welcomeSecondaryText:{color:WHITE,fontSize:15,fontWeight:'700'},welcomeFree:{color:'rgba(255,255,255,.86)',fontSize:12,textAlign:'center',marginTop:2},welcomeBottom:{marginTop:'auto',alignItems:'center',paddingBottom:Platform.OS==='ios'?42:24},welcomeLine:{width:38,height:1,backgroundColor:'rgba(255,255,255,.45)',marginBottom:12},welcomeBottomText:{color:'rgba(255,255,255,.86)',fontSize:13,lineHeight:18,textAlign:'center'},
  projectsHeader:{paddingTop:Platform.OS==='ios'?58:20,paddingHorizontal:16,paddingBottom:12,backgroundColor:WHITE,flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderBottomColor:'#EEF1F4'},projectsMenuBtn:{width:42,height:38,alignItems:'flex-start',justifyContent:'center'},menuBackdrop:{flex:1,backgroundColor:'rgba(15,23,42,.28)',justifyContent:'flex-start'},sideMenu:{width:'78%',maxWidth:330,minHeight:'100%',backgroundColor:WHITE,paddingTop:Platform.OS==='ios'?66:28,paddingHorizontal:20,shadowColor:'#000',shadowOpacity:.18,shadowRadius:16,shadowOffset:{width:5,height:0}},sideMenuTitle:{fontSize:25,fontWeight:'900',color:INK},sideMenuSub:{fontSize:12,fontWeight:'800',color:BLUE,letterSpacing:1,marginTop:3,marginBottom:22},sideMenuItem:{minHeight:54,borderBottomWidth:1,borderBottomColor:'#EDF1F5',justifyContent:'center'},sideMenuItemText:{fontSize:16,fontWeight:'750',color:INK},simplePage:{padding:18,gap:12},infoCard:{minHeight:78,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:16,padding:14,flexDirection:'row',alignItems:'center',gap:12},infoIcon:{width:44,height:44,borderRadius:14,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},infoIconText:{color:BLUE,fontSize:18,fontWeight:'900'},infoTitle:{fontSize:17,fontWeight:'850',color:INK},infoText:{fontSize:13,color:MUTED,marginTop:3,lineHeight:18},helpRow:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:16,padding:14,flexDirection:'row',alignItems:'center',gap:12},helpNum:{width:34,height:34,borderRadius:10,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},helpNumText:{color:WHITE,fontWeight:'900'},helpText:{flex:1,fontSize:15,lineHeight:20,color:INK,fontWeight:'650'},moreAction:{backgroundColor:BLUE,borderRadius:18,padding:18},moreActionTitle:{color:WHITE,fontSize:18,fontWeight:'900'},moreActionText:{color:'#EAF3FF',fontSize:13,marginTop:4},projectsMenu:{width:42,fontSize:22,color:INK},projectsHeaderTitle:{flex:1,fontSize:18,fontWeight:'850',color:INK,textAlign:'center'},projectsPlus:{width:38,height:38,borderRadius:11,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},projectsPlusText:{fontSize:26,lineHeight:29,color:WHITE,fontWeight:'500'},searchBox:{height:44,marginHorizontal:14,marginTop:12,borderRadius:13,backgroundColor:'#F0F2F5',flexDirection:'row',alignItems:'center',paddingHorizontal:12},searchIcon:{fontSize:20,color:'#697386',marginRight:7},searchInput:{flex:1,fontSize:14,color:INK},filterRow:{paddingHorizontal:14,paddingVertical:10,flexDirection:'row',gap:8},filterChip:{paddingHorizontal:14,height:34,borderRadius:10,backgroundColor:'#EEF1F5',alignItems:'center',justifyContent:'center'},filterChipOn:{backgroundColor:BLUE},filterText:{fontSize:12,fontWeight:'700',color:'#657184'},filterTextOn:{color:WHITE},projectCardMock:{minHeight:88,backgroundColor:WHITE,borderWidth:1,borderColor:'#E3E8EE',borderRadius:15,flexDirection:'row',overflow:'hidden',shadowColor:'#000',shadowOpacity:.035,shadowRadius:6,shadowOffset:{width:0,height:2}},projectThumb:{width:62,height:62,borderRadius:11,backgroundColor:'#E9E4DD',overflow:'hidden',position:'relative'},thumbWall:{position:'absolute',left:9,right:9,top:10,bottom:10,borderWidth:2,borderColor:'#A59D91'},thumbCabinet:{position:'absolute',left:15,right:15,bottom:14,height:14,backgroundColor:'#C6B9A8',borderWidth:1,borderColor:'#9C8D7B'},statusPill:{alignSelf:'flex-start',marginTop:5,paddingHorizontal:8,paddingVertical:3,borderRadius:8,backgroundColor:'#DDF6E7'},statusPillDone:{backgroundColor:'#DDF5F4'},statusPillBudget:{backgroundColor:'#FFF4D6'},statusPillProject:{backgroundColor:'#E6F6EC'},statusText:{fontSize:9.5,fontWeight:'800',color:'#248653'},statusTextDone:{color:'#168B88'},statusTextBudget:{color:'#9A6700'},statusTextProject:{color:'#177245'},bottomNav:{minHeight:84,paddingTop:6,paddingBottom:Platform.OS==='ios'?20:7,borderTopWidth:1,borderTopColor:'#E5E9EF',backgroundColor:WHITE,flexDirection:'row',alignItems:'center'},bottomNavItem:{flex:1,alignItems:'center',justifyContent:'center'},bottomNavIcon:{fontSize:22,color:'#1C2733'},bottomNavIconOn:{fontSize:22,color:BLUE},bottomNavText:{fontSize:11,color:'#1C2733',marginTop:3},bottomNavTextOn:{fontSize:11,color:BLUE,fontWeight:'800',marginTop:3},
  simpleTop:{paddingTop:Platform.OS==='ios'?58:20,paddingHorizontal:16,paddingBottom:14,backgroundColor:WHITE,borderBottomWidth:1,borderBottomColor:'#E7EBF0',flexDirection:'row',alignItems:'center'},simpleBack:{width:30,fontSize:32,lineHeight:32,color:INK},simpleTopTitle:{flex:1,textAlign:'center',fontSize:18,fontWeight:'850',color:INK},newEnvPad:{padding:18,gap:14},newEnvLabel:{fontSize:14,fontWeight:'800',color:'#2B3440',marginTop:2},roomTypeGrid:{flexDirection:'row',flexWrap:'wrap',gap:9},roomTypeCard:{width:'31.5%',height:92,borderRadius:14,borderWidth:1.2,borderColor:'#D9E0E8',backgroundColor:WHITE,alignItems:'center',justifyContent:'center'},roomTypeCardOn:{borderColor:BLUE,borderWidth:2,backgroundColor:'#F7FBFF'},roomTypeIcon:{fontSize:27,color:'#394553',fontWeight:'700'},roomTypeText:{fontSize:11.5,fontWeight:'750',color:'#394553',marginTop:8,textAlign:'center'},createEnvBtn:{height:54,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center',marginTop:4},createEnvText:{fontSize:16,fontWeight:'850',color:WHITE},
  summaryTechPosition:{fontSize:11,color:'#7A8794',marginTop:3},
  techTypeBadge:{minWidth:52,height:38,paddingHorizontal:8,borderRadius:8,borderWidth:1,borderColor:'#C7D0D9',backgroundColor:'#F7F9FA',alignItems:'center',justifyContent:'center'},
  techTypeBadgeText:{fontSize:9,fontWeight:'800',color:'#334155',textTransform:'uppercase'},
  objStructure:{backgroundColor:'rgba(217,224,229,.86)',borderColor:'#65727E',borderRadius:1},
  objPoint:{backgroundColor:WHITE,borderColor:'#6B7785',borderRadius:20},
  techDimLine:{position:'absolute',bottom:7,height:13,borderTopWidth:1,borderTopColor:TECH.dim,flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start'},
  techDimTick:{width:1,height:7,backgroundColor:TECH.dim,marginTop:-3},
  techDimText:{position:'absolute',top:-8,alignSelf:'center',fontSize:7.5,fontWeight:'700',color:TECH.dim,backgroundColor:'rgba(255,255,255,.96)',paddingHorizontal:3},
  selectedPosTag:{position:'absolute',top:0,right:0,backgroundColor:'#EAF3FF',borderRadius:5,paddingHorizontal:4,paddingVertical:2},
  selectedPosText:{fontSize:7,color:BLUE,fontWeight:'800'},
  frontObjLabel:{fontSize:8,fontWeight:'800',color:'#34404B',textAlign:'center'},
  frontDoor:{flex:1,width:'100%',borderWidth:1,borderColor:'#697580',backgroundColor:'#FAFBFC',alignItems:'center',justifyContent:'center'},
  frontDoorHandle:{position:'absolute',right:4,top:'52%',width:3,height:3,borderRadius:2,backgroundColor:'#697580'},
  frontWindow:{flex:1,width:'100%',borderWidth:1,borderColor:'#71808C',backgroundColor:'#F7FAFC',alignItems:'center',justifyContent:'center'},
  frontWindowMid:{position:'absolute',left:0,right:0,top:'50%',height:1,backgroundColor:'#A8B2BD'},
  frontSink:{flex:1,width:'100%',backgroundColor:'#F3F6F8',borderWidth:1,borderColor:'#87939D',alignItems:'center',justifyContent:'center'},
  frontSinkBowl:{width:'45%',height:'45%',borderWidth:1,borderColor:'#87939D',borderRadius:4,backgroundColor:WHITE},
  frontStove:{flex:1,width:'100%',backgroundColor:'#F1F4F6',borderWidth:1,borderColor:'#7C8994',alignItems:'center',justifyContent:'center'},
  burnerRow:{flexDirection:'row',gap:2,marginBottom:2},burner:{width:5,height:5,borderRadius:3,borderWidth:1,borderColor:'#65727E'},
  frontFridge:{flex:1,width:'100%',backgroundColor:'#EDF1F4',borderWidth:1,borderColor:'#74818C',alignItems:'center',justifyContent:'center'},
  fridgeSplit:{position:'absolute',left:0,right:0,top:'30%',height:1,backgroundColor:'#A1ABB4'},
  frontPoint:{alignItems:'center',justifyContent:'center'},frontPointMark:{fontSize:13,color:'#586674',fontWeight:'500'},frontPointText:{fontSize:5.8,color:'#586674',fontWeight:'700'},

  techEditSheet:{borderTopLeftRadius:24,borderTopRightRadius:24,paddingTop:8},
  techEditHead:{flexDirection:'row',alignItems:'center',gap:11,marginBottom:6},techEditEyebrow:{fontSize:9.5,fontWeight:'900',letterSpacing:1.1,color:BLUE},techEditTitle:{fontSize:20,fontWeight:'900',color:INK,lineHeight:23},
  techInfoStrip:{marginTop:10,borderRadius:12,backgroundColor:'#F4F8FC',borderWidth:1,borderColor:'#DDE8F3',paddingHorizontal:12,paddingVertical:9},techInfoTitle:{fontSize:11,fontWeight:'900',color:'#304256'},techInfoText:{fontSize:11,color:MUTED,lineHeight:15,marginTop:2},voiceMeasureCard:{marginTop:10,borderWidth:1,borderColor:'#BFD9FA',backgroundColor:'#F5F9FF',borderRadius:16,padding:12,flexDirection:'row',gap:10,alignItems:'center'},voiceMeasureTitle:{fontSize:13,fontWeight:'900',color:INK},voiceMeasureHint:{fontSize:11.5,color:MUTED,lineHeight:16,marginTop:2},voiceTranscript:{fontSize:11.5,color:INK,fontWeight:'700',marginTop:6},voiceMessage:{fontSize:11,color:BLUE,fontWeight:'750',marginTop:4},voiceMicBtn:{width:66,height:66,borderRadius:18,borderWidth:1.5,borderColor:'#9FC7F8',backgroundColor:WHITE,alignItems:'center',justifyContent:'center'},voiceMicBtnOn:{backgroundColor:BLUE,borderColor:BLUE},voiceMicIcon:{fontSize:20},voiceMicText:{fontSize:10,fontWeight:'900',color:BLUE,marginTop:2},
  miniInputWrap:{minHeight:50,borderWidth:1.4,borderColor:'#CBD5E1',borderRadius:13,backgroundColor:WHITE,flexDirection:'row',alignItems:'center',paddingHorizontal:10},miniInputTech:{flex:1,color:INK,fontSize:18,fontWeight:'800',paddingVertical:9},miniUnit:{fontSize:12,fontWeight:'800',color:'#7A8794',marginLeft:6},
  measureDragHint:{fontSize:10.5,color:'#657487',marginTop:-3,marginBottom:7},measureDiagram:{height:78,borderRadius:13,backgroundColor:'#F8FAFC',borderWidth:1,borderColor:'#E0E7EF',marginBottom:10,position:'relative',overflow:'hidden'},measureWallLine:{position:'absolute',left:14,right:14,top:31,height:4,borderRadius:2,backgroundColor:'#313A43'},measureObject:{position:'absolute',top:17,height:31,minWidth:44,borderRadius:8,backgroundColor:'#EAF3FF',borderWidth:1.5,borderColor:BLUE,alignItems:'center',justifyContent:'center',flexDirection:'row',gap:4},measureObjectText:{fontSize:8.5,fontWeight:'900',color:BLUE,paddingLeft:4},measureObjectGrip:{fontSize:11,fontWeight:'900',color:BLUE,paddingRight:4},measureDiagramLeft:{position:'absolute',left:12,bottom:7,fontSize:10,fontWeight:'750',color:'#566676'},measureDiagramRight:{position:'absolute',right:12,bottom:7,fontSize:10,fontWeight:'750',color:'#566676'},
  checkCard:{marginTop:12,borderRadius:14,borderWidth:1,borderColor:'#DDE5EC',backgroundColor:'#FBFCFD',padding:12},checkRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},checkLabel:{fontSize:11.5,fontWeight:'850',color:'#344454'},checkValue:{fontSize:11,fontWeight:'900',color:'#B45309'},checkValueOk:{color:'#178653'},checkFormula:{fontSize:10.5,color:'#718096',marginTop:3},techFootHint:{fontSize:11,color:'#657487',lineHeight:16,marginTop:10},techSaveBtn:{height:52,borderRadius:14,backgroundColor:BLUE,alignItems:'center',justifyContent:'center',marginTop:15},techSaveBtnText:{fontSize:15,fontWeight:'900',color:WHITE},
  swingRow:{flexDirection:'row',gap:8,marginTop:8,marginBottom:4},
  swingOption:{flex:1,height:44,borderRadius:10,borderWidth:1,borderColor:'#C8D2DC',backgroundColor:'#F7F9FB',alignItems:'center',justifyContent:'center'},
  swingOptionOn:{borderColor:BLUE,backgroundColor:'#EAF3FF'},
  swingOptionText:{fontSize:12,fontWeight:'700',color:'#52606D'},
  swingOptionTextOn:{color:BLUE},
  wallEditIcon:{width:46,height:46,borderRadius:13,backgroundColor:BLUE_SOFT,borderWidth:1,borderColor:'#C9DFFF',alignItems:'center',justifyContent:'center'},wallEditIconText:{fontSize:22,fontWeight:'900',color:BLUE},
  frontDoorInner:{position:'absolute',left:5,right:5,top:5,bottom:5,borderWidth:1,borderColor:'#B4BEC7'},

  exportPage:{padding:14,paddingBottom:110,gap:12},
  exportIntro:{paddingHorizontal:4,paddingVertical:4},exportIntroTitle:{fontSize:22,fontWeight:'850',color:INK},exportIntroText:{fontSize:13.5,color:MUTED,marginTop:3},
  exportCard:{backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,borderRadius:18,padding:10,gap:8,overflow:'hidden'},exportCardHead:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8},exportCardTitle:{fontSize:10.5,fontWeight:'900',letterSpacing:.8,color:'#3E4B58'},
  exportChips:{flexDirection:'row',gap:5,flexWrap:'wrap'},exportChip:{minWidth:28,height:28,borderRadius:8,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center',backgroundColor:'#F7F9FB'},exportChipOn:{backgroundColor:BLUE,borderColor:BLUE},exportChipText:{fontSize:11,fontWeight:'850',color:'#526171'},exportChipTextOn:{color:WHITE},
  exportPhoto:{height:235,borderRadius:12,resizeMode:'contain',backgroundColor:'#EDF1F4'},exportEmptyVisual:{height:150,borderRadius:12,backgroundColor:'#F1F4F6',alignItems:'center',justifyContent:'center',padding:20},exportEmptyText:{fontSize:13,color:MUTED,textAlign:'center'},
  exportTechBox:{borderTopWidth:1,borderTopColor:'#E6EBEF'},exportTechRow:{minHeight:42,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,borderBottomWidth:1,borderBottomColor:'#EDF1F4'},exportTechItem:{paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#EDF1F4'},exportTechStrong:{fontSize:12.5,fontWeight:'800',color:INK},exportTechValue:{fontSize:11.5,color:'#526171',marginTop:2},exportNotes:{fontSize:13,lineHeight:19,color:'#354354',backgroundColor:'#F7F9FB',borderRadius:10,padding:12,borderWidth:1,borderColor:'#E4E9EE'},
  exportFooter:{position:'absolute',left:0,right:0,bottom:0,paddingHorizontal:14,paddingTop:10,paddingBottom:Platform.OS==='ios'?28:14,backgroundColor:'rgba(243,246,249,.98)',borderTopWidth:1,borderTopColor:'#DCE3E9'},


  modeTop:{paddingTop:Platform.OS==='ios'?64:30,paddingHorizontal:22,paddingBottom:20},modeTitle:{fontSize:28,lineHeight:34,fontWeight:'900',color:INK,letterSpacing:-.6,marginTop:26},modeSub:{fontSize:15,color:MUTED,marginTop:5},modeCards:{paddingHorizontal:16,gap:12},modeCard:{minHeight:150,borderRadius:22,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE,padding:18,flexDirection:'row',alignItems:'center',gap:13,shadowColor:'#000',shadowOpacity:.04,shadowRadius:10,shadowOffset:{width:0,height:4}},modeCardQuick:{borderColor:'#B9D7FF',backgroundColor:'#F8FBFF'},modeIcon:{width:50,height:50,borderRadius:16,backgroundColor:BLUE_SOFT,alignItems:'center',justifyContent:'center'},modeIconText:{fontSize:24},modeCardTitle:{fontSize:20,fontWeight:'900',color:INK},modeCardText:{fontSize:13,lineHeight:18,color:MUTED,marginTop:4},modeCardHint:{fontSize:11.5,fontWeight:'850',color:BLUE,marginTop:10},modeArrow:{fontSize:34,color:BLUE,fontWeight:'300'},modeBack:{margin:18,marginTop:'auto',paddingBottom:Platform.OS==='ios'?18:4},
  quickCameraActions:{width:'100%',gap:10,marginTop:8},quickCameraActionPrimary:{minHeight:64,borderRadius:16,backgroundColor:BLUE,paddingHorizontal:18,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:12},quickCameraActionSecondary:{minHeight:64,borderRadius:16,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,paddingHorizontal:18,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:12},quickCameraActionIcon:{fontSize:22},quickCameraActionTitleWhite:{fontSize:15,fontWeight:'900',color:WHITE},quickCameraActionSubWhite:{fontSize:10.5,color:'#DCEBFF',marginTop:1},quickCameraActionTitle:{fontSize:15,fontWeight:'900',color:INK},quickCameraActionSub:{fontSize:10.5,color:MUTED,marginTop:1},quickResetZoom:{paddingHorizontal:10,height:30,borderRadius:9,backgroundColor:WHITE,borderWidth:1,borderColor:BORDER,alignItems:'center',justifyContent:'center'},quickResetZoomText:{fontSize:10,fontWeight:'900',color:BLUE},quickEditorDock:{position:'absolute',left:0,right:0,bottom:0,backgroundColor:WHITE,borderTopWidth:1,borderTopColor:'#E1E7ED',paddingTop:7,paddingHorizontal:8,paddingBottom:Platform.OS==='ios'?18:8},quickEditorTools:{height:54,flexDirection:'row',alignItems:'stretch',gap:4},quickEditorTool:{flex:1,borderRadius:10,alignItems:'center',justifyContent:'center'},quickEditorToolOn:{backgroundColor:BLUE_SOFT},quickEditorIcon:{fontSize:17,fontWeight:'900',color:'#354456'},quickEditorLabel:{fontSize:8.5,fontWeight:'800',color:'#354456',marginTop:2},quickEditorTextOn:{color:BLUE},quickEditorActions:{height:42,marginTop:5,flexDirection:'row',gap:6},quickEditorUndo:{flex:.85,borderRadius:11,backgroundColor:'#F6F8FA',borderWidth:1,borderColor:'#E2E7EC',alignItems:'center',justifyContent:'center'},quickEditorUndoText:{fontSize:10.5,fontWeight:'850',color:'#536273'},quickEditorSave:{flex:1,borderRadius:11,backgroundColor:'#EEF3F7',alignItems:'center',justifyContent:'center'},quickEditorSaveText:{fontSize:12,fontWeight:'900',color:INK},quickEditorFinish:{flex:1.15,borderRadius:11,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},quickEditorFinishText:{fontSize:12,fontWeight:'900',color:WHITE},
  quickInfo:{borderRadius:16,backgroundColor:BLUE_SOFT,padding:14},quickInfoTitle:{fontSize:14,fontWeight:'900',color:BLUE},quickInfoText:{fontSize:12.5,lineHeight:18,color:'#52647A',marginTop:3},quickCameraEmpty:{flex:1,padding:22,alignItems:'center',justifyContent:'center',gap:12},quickCameraIcon:{fontSize:52},quickCameraTitle:{fontSize:24,fontWeight:'900',color:INK},quickCameraText:{fontSize:14,lineHeight:20,color:MUTED,textAlign:'center',marginBottom:10},quickToolbar:{padding:12,flexDirection:'row',alignItems:'center',gap:10},quickToolbarText:{flex:1,fontSize:12.5,lineHeight:17,color:MUTED},quickNewPhoto:{height:38,paddingHorizontal:12,borderRadius:11,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},quickNewPhotoText:{color:WHITE,fontSize:13,fontWeight:'900'},quickPhotoStage:{alignSelf:'center',backgroundColor:'#111',borderRadius:16,overflow:'hidden',borderWidth:1,borderColor:'#D6DEE7'},quickMarksList:{paddingHorizontal:12,paddingTop:10,gap:6},quickMarkRow:{minHeight:44,borderRadius:12,borderWidth:1,borderColor:BORDER,backgroundColor:WHITE,paddingHorizontal:10,flexDirection:'row',alignItems:'center',gap:10},quickMarkIndex:{width:24,height:24,borderRadius:12,textAlign:'center',lineHeight:24,backgroundColor:BLUE_SOFT,color:BLUE,fontWeight:'900'},quickMarkValue:{flex:1,fontSize:15,fontWeight:'850',color:INK},quickMarkDelete:{fontSize:12,fontWeight:'800',color:'#C62828'},quickThumbs:{padding:12,gap:8},quickThumbWrap:{width:76,borderRadius:11,borderWidth:2,borderColor:'transparent',padding:3},quickThumbOn:{borderColor:BLUE},quickThumb:{width:66,height:58,borderRadius:8,backgroundColor:'#DDE3EA'},quickThumbText:{fontSize:10.5,textAlign:'center',color:MUTED,marginTop:3},

  homeModeWrap:{paddingHorizontal:14,paddingTop:12},homeModeTitle:{fontSize:15,fontWeight:'900',color:INK,marginBottom:9},homeModeRow:{flexDirection:'row',gap:9},homeModeCard:{flex:1,minHeight:104,borderRadius:16,borderWidth:1.2,borderColor:'#DCE3EA',backgroundColor:WHITE,padding:12,justifyContent:'center'},homeModeQuick:{borderColor:'#BFD9FA',backgroundColor:'#F6FAFF'},homeModeIcon:{fontSize:20,marginBottom:6},homeModeCardTitle:{fontSize:14,fontWeight:'900',color:INK},homeModeCardText:{fontSize:11,color:MUTED,marginTop:3},
  quickSavedCard:{minHeight:88,backgroundColor:WHITE,borderWidth:1,borderColor:'#DDE5ED',borderRadius:15,flexDirection:'row',alignItems:'center',gap:12,padding:11},quickSavedThumb:{width:66,height:66,borderRadius:11,overflow:'hidden',backgroundColor:'#EEF3F7',alignItems:'center',justifyContent:'center'},quickSavedIcon:{fontSize:24},quickSavedPill:{alignSelf:'flex-start',marginTop:5,paddingHorizontal:8,paddingVertical:3,borderRadius:8,backgroundColor:'#EAF3FF'},quickSavedPillText:{fontSize:9.5,fontWeight:'800',color:BLUE},quickToolbarSub:{fontSize:10.5,color:MUTED,marginTop:2},
  quickBottomActions:{position:'absolute',left:0,right:0,bottom:0,minHeight:82,paddingHorizontal:10,paddingTop:9,paddingBottom:Platform.OS==='ios'?20:10,backgroundColor:WHITE,borderTopWidth:1,borderTopColor:'#E3E8EE',flexDirection:'row',gap:7},quickBottomSecondary:{flex:1,height:46,borderRadius:12,borderWidth:1,borderColor:'#CBD5E1',alignItems:'center',justifyContent:'center'},quickBottomSecondaryText:{fontSize:11,fontWeight:'850',color:INK},quickBottomSave:{flex:.75,height:46,borderRadius:12,backgroundColor:'#EAF3FF',alignItems:'center',justifyContent:'center'},quickBottomSaveText:{fontSize:12,fontWeight:'900',color:BLUE},quickBottomFinish:{flex:1,height:46,borderRadius:12,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},quickBottomFinishText:{fontSize:11.5,fontWeight:'900',color:WHITE},
  homeHeaderSub:{fontSize:10.5,color:MUTED,marginTop:1},homeCleanBody:{padding:18,paddingBottom:30},homeHero:{paddingTop:12,paddingBottom:20},homeHeroEyebrow:{fontSize:10,fontWeight:'900',letterSpacing:1.3,color:BLUE},homeHeroTitle:{fontSize:27,fontWeight:'900',color:INK,marginTop:5},homeHeroText:{fontSize:13.5,color:MUTED,marginTop:5},homeModeStack:{gap:12},homeChoiceCard:{minHeight:132,borderRadius:20,borderWidth:1,borderColor:'#DCE3EA',backgroundColor:WHITE,padding:16,flexDirection:'row',alignItems:'center',gap:13,shadowColor:'#000',shadowOpacity:.04,shadowRadius:9,shadowOffset:{width:0,height:3}},homeChoiceQuick:{borderColor:'#BFD9FA',backgroundColor:'#F8FBFF'},homeChoiceIcon:{width:48,height:48,borderRadius:15,backgroundColor:'#EEF2F6',alignItems:'center',justifyContent:'center'},homeChoiceIconQuick:{backgroundColor:'#E7F2FF'},homeChoiceIconText:{fontSize:22},homeChoiceTitle:{fontSize:17,fontWeight:'900',color:INK},homeChoiceText:{fontSize:12.5,lineHeight:18,color:MUTED,marginTop:3},homeChoiceHint:{fontSize:10.5,fontWeight:'850',color:BLUE,marginTop:8},homeChoiceArrow:{fontSize:30,color:'#A6B1BE',fontWeight:'300'},homeProjectsShortcut:{marginTop:18,minHeight:72,borderRadius:17,backgroundColor:'#F2F5F8',paddingHorizontal:15,flexDirection:'row',alignItems:'center',gap:12},homeProjectsShortcutIcon:{fontSize:22,color:BLUE},homeProjectsShortcutTitle:{fontSize:14,fontWeight:'900',color:INK},homeProjectsShortcutText:{fontSize:11.5,color:MUTED,marginTop:2},projectsHomeBtn:{width:38,height:38,borderRadius:11,backgroundColor:'#EEF3F7',alignItems:'center',justifyContent:'center'},projectsHomeBtnText:{fontSize:19,color:INK},projectsIntro:{paddingHorizontal:16,paddingTop:15},projectsIntroTitle:{fontSize:21,fontWeight:'900',color:INK},projectsIntroText:{fontSize:12.5,lineHeight:18,color:MUTED,marginTop:3},projectsLibraryList:{padding:14,paddingBottom:24,gap:10},libraryCard:{minHeight:96,borderRadius:17,borderWidth:1,borderColor:'#E0E6ED',backgroundColor:WHITE,flexDirection:'row',overflow:'hidden',shadowColor:'#000',shadowOpacity:.035,shadowRadius:7,shadowOffset:{width:0,height:2}},libraryCardOpen:{flex:1,padding:11,flexDirection:'row',alignItems:'center',gap:12},libraryThumb:{width:72,height:72,borderRadius:12,overflow:'hidden',backgroundColor:'#EEF2F5'},libraryClient:{fontSize:16.5,fontWeight:'900',color:INK},libraryProject:{fontSize:12.5,fontWeight:'650',color:MUTED,marginTop:2},libraryMetaRow:{flexDirection:'row',alignItems:'center',gap:7,marginTop:8},libraryTypePill:{paddingHorizontal:7,paddingVertical:3,borderRadius:7,backgroundColor:'#EEF2F6'},libraryTypeQuick:{backgroundColor:'#EAF3FF'},libraryTypeText:{fontSize:9,fontWeight:'850',color:'#5B6775'},libraryTypeQuickText:{color:BLUE},libraryCount:{fontSize:9.5,color:MUTED},libraryDelete:{width:34,alignItems:'center',justifyContent:'center',borderLeftWidth:1,borderLeftColor:'#EEF1F4'},planMini:{flex:1,backgroundColor:'#F5F1EA',alignItems:'center',justifyContent:'center'},planMiniRoom:{width:44,height:37,borderWidth:2,borderColor:'#8C8173'},planMiniLine:{position:'absolute',width:28,height:2,backgroundColor:'#8C8173',transform:[{rotate:'-28deg'}]},planMiniText:{fontSize:7,fontWeight:'900',color:'#7A7065',marginTop:4},quickToolHeader:{paddingHorizontal:14,paddingVertical:10,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10},quickToolHeaderTitle:{fontSize:14,fontWeight:'900',color:INK},quickToolHeaderSub:{fontSize:11.5,color:MUTED,marginTop:2},quickActionDock:{position:'absolute',left:0,right:0,bottom:0,minHeight:88,paddingHorizontal:9,paddingTop:8,paddingBottom:Platform.OS==='ios'?20:9,backgroundColor:WHITE,borderTopWidth:1,borderTopColor:'#E1E7ED',flexDirection:'row',alignItems:'center',gap:5},quickDockTool:{flex:1,height:55,borderRadius:13,backgroundColor:'#F3F6F9',alignItems:'center',justifyContent:'center'},quickDockIcon:{fontSize:18,fontWeight:'900',color:INK},quickDockLabel:{fontSize:9.5,fontWeight:'800',color:INK,marginTop:3},quickDockFinish:{flex:1.25,height:55,borderRadius:13,backgroundColor:BLUE,alignItems:'center',justifyContent:'center'},quickDockFinishIcon:{fontSize:17,fontWeight:'900',color:WHITE},quickDockFinishLabel:{fontSize:10,fontWeight:'900',color:WHITE,marginTop:3},quickNoteCard:{marginHorizontal:12,marginTop:10,borderRadius:14,borderWidth:1,borderColor:'#DCE4EC',backgroundColor:'#FAFCFE',padding:12,flexDirection:'row',alignItems:'center',gap:10},quickNoteIcon:{width:34,height:34,borderRadius:10,backgroundColor:'#EAF3FF',alignItems:'center',justifyContent:'center'},quickNoteIconText:{fontSize:16,fontWeight:'900',color:BLUE},quickNoteLabel:{fontSize:10,fontWeight:'900',color:BLUE,textTransform:'uppercase'},quickNoteText:{fontSize:12.5,lineHeight:17,color:INK,marginTop:2},quickNoteInput:{height:120,textAlignVertical:'top',paddingTop:12,marginTop:14},
});
