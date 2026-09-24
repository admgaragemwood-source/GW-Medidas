import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

export const gwCloudConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const gwSupabase = gwCloudConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        storage: AsyncStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export async function gwGetSession() {
  if (!gwSupabase) return null;
  const { data, error } = await gwSupabase.auth.getSession();
  if (error) throw error;
  return data?.session || null;
}

export async function gwSignIn(email, password) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  const { data, error } = await gwSupabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  if (error) throw error;
  return data?.session || null;
}

export async function gwSignOut() {
  if (!gwSupabase) return;
  const { error } = await gwSupabase.auth.signOut();
  if (error) throw error;
}

export async function gwLoadWorkspaceProjects() {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');

  const { data: authData, error: authError } = await gwSupabase.auth.getUser();
  if (authError) throw authError;
  const user = authData?.user;
  if (!user) throw new Error('Faça login com a mesma conta usada no GW Assistente.');

  const { data: membership, error: membershipError } = await gwSupabase
    .from('gw_memberships')
    .select('company_id,role,active,created_at')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (!membership?.company_id) throw new Error('Não encontrei a empresa vinculada a esta conta no GW Assistente.');

  const companyId = membership.company_id;
  const [
    { data: projetoRows, error: projetosError },
    { data: clienteRows, error: clientesError },
  ] = await Promise.all([
    gwSupabase.from('gw_projetos').select('source_id,data,updated_at,created_at').eq('company_id', companyId).order('created_at', { ascending: true }),
    gwSupabase.from('gw_clientes').select('source_id,data,updated_at,created_at').eq('company_id', companyId).order('created_at', { ascending: true }),
  ]);

  if (projetosError) throw projetosError;
  if (clientesError) throw clientesError;

  return {
    companyId,
    user,
    projetos: (projetoRows || []).map(row => ({ ...(row?.data || {}), __sourceId: row?.source_id, __updatedAt: row?.updated_at })),
    clientes: (clienteRows || []).map(row => ({ ...(row?.data || {}), __sourceId: row?.source_id, __updatedAt: row?.updated_at })),
  };
}

const norm = value => String(value || '').trim().toLowerCase();
const safeSlug = value => norm(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const roomId = (parentId, ambiente, index) => String(ambiente?.id || ambiente?.source_id || `gw-room-${parentId}-${index}-${safeSlug(ambiente?.nome || ambiente?.name || 'ambiente')}`);

function defaultRoom(parentId, ambiente, index) {
  const name = ambiente?.nome || ambiente?.name || ambiente?.ambiente || `Ambiente ${index + 1}`;
  return {
    id: roomId(parentId, ambiente, index),
    name,
    wallCount: 4,
    lengths: [3.20, 2.80, 3.20, 2.80],
    height: 2.65,
    elements: [],
    photos: [],
    notes: '',
    createdAt: Date.now(),
    gwAmbienteId: ambiente?.id || null,
    gwImported: true,
  };
}

function mergeRooms(existingRooms = [], remoteRooms = [], parentId) {
  const existing = Array.isArray(existingRooms) ? existingRooms : [];
  const remote = Array.isArray(remoteRooms) ? remoteRooms : [];
  if (!remote.length) return existing;

  const used = new Set();
  const merged = remote.map((ambiente, index) => {
    const rid = roomId(parentId, ambiente, index);
    const rname = norm(ambiente?.nome || ambiente?.name || ambiente?.ambiente);
    const current = existing.find(room => String(room.id) === rid)
      || existing.find(room => rname && norm(room.name) === rname);
    if (current) {
      used.add(current.id);
      return {
        ...current,
        name: ambiente?.nome || ambiente?.name || current.name,
        gwAmbienteId: ambiente?.id || current.gwAmbienteId || null,
        gwImported: true,
      };
    }
    return defaultRoom(parentId, ambiente, index);
  });

  for (const room of existing) if (!used.has(room.id)) merged.push(room);
  return merged;
}

function clientMap(clients = []) {
  const map = new Map();
  clients.forEach(c => {
    for (const candidate of [c.id, c.__sourceId, c.codigo, c.uuid]) {
      if (candidate != null) map.set(String(candidate), c);
    }
  });
  return map;
}

function clientNameFor(item, map, fallback = 'Sem cliente') {
  const c = map.get(String(item?.clienteId ?? item?.cliente_id ?? ''));
  return item?.cliente || c?.nome || c?.name || fallback;
}

function explicitRoomsFrom(item) {
  if (Array.isArray(item?.ambientes)) return item.ambientes;
  if (Array.isArray(item?.rooms)) return item.rooms;
  return [];
}

export function mergeGwProjects(localProjects = [], remotePayload = {}) {
  const local = Array.isArray(localProjects) ? localProjects : [];
  const remoteProjects = Array.isArray(remotePayload?.projetos) ? remotePayload.projetos : [];
  const clients = Array.isArray(remotePayload?.clientes) ? remotePayload.clientes : [];
  const byClientId = clientMap(clients);

  const importedProjects = remoteProjects.map((rp, index) => {
    const sourceId = String(rp?.id ?? rp?.__sourceId ?? `gw-project-${index}`);
    const current = local.find(p => p.gwSourceType === 'projeto' && String(p.gwProjectId || '') === sourceId)
      || local.find(p => p.gwImported && !p.gwSourceType && String(p.gwProjectId || '') === sourceId);
    const clientName = clientNameFor(rp, byClientId, current?.client || 'Sem cliente');
    const projectName = rp?.nome || rp?.projeto || rp?.ambiente || current?.name || `Projeto ${index + 1}`;
    const ambientes = explicitRoomsFrom(rp);
    return {
      ...(current || {}),
      id: current?.id || `gw-project-${sourceId}`,
      client: clientName,
      name: projectName,
      rooms: mergeRooms(current?.rooms || [], ambientes, sourceId),
      createdAt: current?.createdAt || Date.now(),
      updatedAt: Date.now(),
      gwImported: true,
      gwSourceType: 'projeto',
      gwProjectId: sourceId,
      gwBudgetId: null,
      gwCompanyId: remotePayload?.companyId || current?.gwCompanyId || null,
      gwSyncAt: Date.now(),
      gwProjectSnapshot: {
        etapa: rp?.etapa || '',
        progresso: rp?.progresso ?? null,
        prazo: rp?.prazo || '',
        tipoProjeto: rp?.tipoProjeto || '',
      },
    };
  });

  // A integração atual usa Projeto como centro do levantamento. Orçamentos não são importados.
  const localOnly = local.filter(p => !p.gwImported);
  return [...localOnly, ...importedProjects];
}


function cleanPhotoMeta(photo = {}) {
  return {
    id: photo?.id || null,
    source: photo?.source || '',
    hasImage: Boolean(photo?.uri || photo?.dataUri),
  };
}

function cleanElement(element = {}) {
  // Envia o conjunto completo de dados técnicos usados pelo próprio Exportar do GW Medidas.
  // Isso evita que o GW Assistente precise "adivinhar" posição, profundidade, ordem visual
  // ou objetos livres ao reconstruir planta e vistas frontais.
  const allowed = [
    'id','type','wall','width','height','depth','thickness','left','right','bottom','top',
    'x','y','free','freeX','freeY','rotation','layer','zIndex','position','side','swing',
    'notes','name','label','offset','inward','orientation'
  ];
  return allowed.reduce((acc, key) => {
    if (element?.[key] !== undefined && element?.[key] !== null) acc[key] = element[key];
    return acc;
  }, {});
}

export function buildGwMeasurementPayload(project = {}) {
  const rooms = Array.isArray(project?.rooms) ? project.rooms : [];
  return {
    version: 2,
    source: 'gw-medidas',
    renderProfile: 'exportar-projeto-6.5.3',
    syncedAt: new Date().toISOString(),
    client: project?.client || '',
    title: project?.name || '',
    budgetId: project?.gwBudgetId || null,
    environments: rooms.map((room, index) => ({
      id: room?.id || `ambiente-${index + 1}`,
      gwAmbienteId: room?.gwAmbienteId || null,
      name: room?.name || `Ambiente ${index + 1}`,
      wallCount: Number(room?.wallCount || 0),
      lengths: Array.isArray(room?.lengths) ? room.lengths.map(Number) : [],
      height: Number(room?.height || 0),
      notes: room?.notes || '',
      elements: Array.isArray(room?.elements) ? room.elements.map(cleanElement) : [],
      photos: Array.isArray(room?.photos) ? room.photos.map(cleanPhotoMeta) : [],
      photoCount: Array.isArray(room?.photos) ? room.photos.length : 0,
      createdAt: room?.createdAt || null,
      updatedAt: Date.now(),
    })),
  };
}

export async function gwSendMeasurementToBudget(project = {}) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  if (project?.gwSourceType !== 'orcamento' || !project?.gwBudgetId) {
    throw new Error('Esta medição não está vinculada a um orçamento do GW Assistente.');
  }

  const session = await gwGetSession();
  if (!session?.user) throw new Error('Conecte sua conta do GW Assistente antes de enviar.');

  const companyId = project?.gwCompanyId;
  if (!companyId) throw new Error('Empresa do GW não identificada nesta medição. Sincronize novamente.');

  const budgetId = String(project.gwBudgetId);
  const { data: row, error: readError } = await gwSupabase
    .from('gw_orcamentos')
    .select('source_id,data,updated_at')
    .eq('company_id', companyId)
    .eq('source_id', budgetId)
    .maybeSingle();

  if (readError) throw readError;
  if (!row) throw new Error('Este orçamento não existe mais no GW Assistente. Sincronize novamente.');

  const currentData = row?.data || {};
  if (String(currentData?.id ?? row?.source_id ?? '') !== budgetId && String(row?.source_id || '') !== budgetId) {
    throw new Error('Não consegui confirmar o vínculo deste orçamento. Nenhum dado foi alterado.');
  }

  const measurement = buildGwMeasurementPayload(project);
  const nextData = {
    ...currentData,
    levantamentoGW: measurement,
    levantamentoGWAtualizadoEm: measurement.syncedAt,
  };

  const { error: updateError } = await gwSupabase
    .from('gw_orcamentos')
    .update({ data: nextData })
    .eq('company_id', companyId)
    .eq('source_id', budgetId);

  if (updateError) throw updateError;

  return {
    budgetId,
    syncedAt: measurement.syncedAt,
    environments: measurement.environments.length,
    photoCount: measurement.environments.reduce((total, room) => total + Number(room.photoCount || 0), 0),
  };
}


export async function gwSendMeasurementToProject(project = {}) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  if (project?.gwSourceType !== 'projeto' || !project?.gwProjectId) {
    throw new Error('Esta medição não está vinculada a um projeto do GW Assistente.');
  }

  const session = await gwGetSession();
  if (!session?.user) throw new Error('Conecte sua conta do GW Assistente antes de enviar.');

  const companyId = project?.gwCompanyId;
  if (!companyId) throw new Error('Empresa do GW não identificada nesta medição. Sincronize novamente.');

  const projectId = String(project.gwProjectId);
  const { data: row, error: readError } = await gwSupabase
    .from('gw_projetos')
    .select('source_id,data,updated_at')
    .eq('company_id', companyId)
    .eq('source_id', projectId)
    .maybeSingle();

  if (readError) throw readError;
  if (!row) throw new Error('Este projeto não existe mais no GW Assistente. Sincronize novamente.');

  const measurement = { ...buildGwMeasurementPayload(project), projectId };
  const currentData = row?.data || {};
  const nextData = {
    ...currentData,
    levantamentoGW: measurement,
    levantamentoGWAtualizadoEm: measurement.syncedAt,
  };

  const { error: updateError } = await gwSupabase
    .from('gw_projetos')
    .update({ data: nextData })
    .eq('company_id', companyId)
    .eq('source_id', projectId);

  if (updateError) throw updateError;

  return {
    projectId,
    syncedAt: measurement.syncedAt,
    environments: measurement.environments.length,
    photoCount: measurement.environments.reduce((total, room) => total + Number(room.photoCount || 0), 0),
  };
}


function makeGwId(prefix = 'gw') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const normalizeName = value => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ');

export async function gwCreateProjectFromLocalMeasurement(project = {}) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  if (project?.gwSourceType) throw new Error('Esta medição já está vinculada ao GW Assistente.');
  if (!String(project?.client || '').trim()) throw new Error('Informe o nome do cliente antes de enviar.');
  if (!Array.isArray(project?.rooms) || project.rooms.length === 0) throw new Error('Crie pelo menos um ambiente antes de enviar.');

  const session = await gwGetSession();
  if (!session?.user) throw new Error('Conecte sua conta do GW Assistente antes de enviar.');
  const workspace = await gwLoadWorkspaceProjects();
  const companyId = workspace.companyId;
  const targetName = normalizeName(project.client);
  let clientData = (workspace.clientes || []).find(c => normalizeName(c?.nome || c?.name) === targetName) || null;
  let clientCreated = false;
  if (!clientData) {
    const clientId = makeGwId('cliente');
    clientData = { id:clientId, nome:String(project.client).trim(), ultimaInteracao:'Hoje', proximaAcao:'Definir próxima ação', origem:'GW Medidas', criadoEm:new Date().toISOString() };
    const { error } = await gwSupabase.from('gw_clientes').upsert({ company_id:companyId, source_id:clientId, data:clientData }, { onConflict:'company_id,source_id' });
    if (error) throw error;
    clientCreated = true;
  }
  const projectId = makeGwId('projeto');
  const measurement = buildGwMeasurementPayload({ ...project, gwProjectId:projectId });
  const nowIso = new Date().toISOString();
  const projectName = String(project?.name || 'Projeto GW Medidas').trim() || 'Projeto GW Medidas';
  const projectData = {
    id:projectId, nome:projectName, projeto:projectName, cliente:String(project.client).trim(),
    clienteId:clientData?.id || clientData?.__sourceId || null, origem:'GW Medidas', etapa:'Levantamento', progresso:0,
    levantamentoGW:measurement, levantamentoGWAtualizadoEm:measurement.syncedAt, criadoEm:nowIso, atualizadoEm:nowIso,
  };
  const { error:projectError } = await gwSupabase.from('gw_projetos').upsert({ company_id:companyId, source_id:projectId, data:projectData }, { onConflict:'company_id,source_id' });
  if (projectError) throw projectError;
  return { companyId, projectId, clientId:clientData?.id || clientData?.__sourceId || null, clientCreated, syncedAt:measurement.syncedAt, environments:measurement.environments.length };
}

function quickMarksForGw(marks = []) {
  return (Array.isArray(marks)?marks:[]).map(m=>({ ...m }));
}

export async function gwCreateProjectFromQuickMeasurement(job = {}) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  if (!String(job?.client || '').trim()) throw new Error('Informe o nome do cliente antes de enviar.');
  const session = await gwGetSession();
  if (!session?.user) throw new Error('Conecte sua conta do GW Assistente antes de enviar.');
  const workspace = await gwLoadWorkspaceProjects();
  const companyId = workspace.companyId;
  const targetName = normalizeName(job.client);
  let clientData = (workspace.clientes || []).find(c => normalizeName(c?.nome || c?.name) === targetName) || null;
  let clientCreated = false;
  if (!clientData) {
    const clientId=makeGwId('cliente');
    clientData={id:clientId,nome:String(job.client).trim(),telefone:job.phone||'',endereco:job.address||'',ultimaInteracao:'Hoje',proximaAcao:'Definir próxima ação',origem:'GW Medidas',criadoEm:new Date().toISOString()};
    const {error}=await gwSupabase.from('gw_clientes').upsert({company_id:companyId,source_id:clientId,data:clientData},{onConflict:'company_id,source_id'}); if(error)throw error; clientCreated=true;
  }
  const projectId=makeGwId('projeto');
  const nowIso=new Date().toISOString();
  const photos=(job.photos||[]).map((ph,i)=>({id:ph.id||`foto-${i+1}`,name:`Foto ${i+1}`,note:ph.note||'',marks:quickMarksForGw(ph.marks),hasImage:Boolean(ph.uri||ph.dataUri),localUri:ph.uri||'',savedAt:ph.savedAt||null}));
  const measurement={version:3,source:'gw-medidas',mode:'quick',syncedAt:nowIso,client:job.client||'',title:job.project||'Medição rápida',phone:job.phone||'',address:job.address||'',environments:[{id:`quick-${job.id||projectId}`,name:job.project||'Medição rápida',wallCount:0,lengths:[],height:0,notes:'',elements:[],photos,photoCount:photos.length,quickMeasurement:true}]};
  const projectName=String(job.project||'Medição rápida').trim();
  const projectData={id:projectId,nome:projectName,projeto:projectName,cliente:String(job.client).trim(),clienteId:clientData?.id||clientData?.__sourceId||null,origem:'GW Medidas',etapa:'Levantamento',progresso:0,levantamentoGW:measurement,levantamentoGWAtualizadoEm:nowIso,criadoEm:nowIso,atualizadoEm:nowIso};
  const {error:projectError}=await gwSupabase.from('gw_projetos').upsert({company_id:companyId,source_id:projectId,data:projectData},{onConflict:'company_id,source_id'}); if(projectError)throw projectError;
  return {companyId,projectId,clientId:clientData?.id||clientData?.__sourceId||null,clientCreated,syncedAt:nowIso,photos:photos.length};
}

export async function gwSendExportSnapshot(project = {}, snapshot = {}) {
  if (!gwSupabase) throw new Error('Integração GW não configurada.');
  if (!snapshot?.image) throw new Error('O Exportar não foi gerado.');
  const session = await gwGetSession();
  if (!session?.user) throw new Error('Conecte sua conta do GW Assistente antes de enviar.');
  const companyId = project?.gwCompanyId;
  if (!companyId) throw new Error('Empresa do GW não identificada. Sincronize novamente.');
  const isBudget = project?.gwSourceType === 'orcamento' && project?.gwBudgetId;
  const isProject = project?.gwSourceType === 'projeto' && project?.gwProjectId;
  if (!isBudget && !isProject) throw new Error('Vincule esta medição ao GW Assistente antes de enviar.');

  const table = isBudget ? 'gw_orcamentos' : 'gw_projetos';
  const sourceId = String(isBudget ? project.gwBudgetId : project.gwProjectId);
  const { data: row, error: readError } = await gwSupabase
    .from(table).select('source_id,data').eq('company_id', companyId).eq('source_id', sourceId).maybeSingle();
  if (readError) throw readError;
  if (!row) throw new Error('O destino não existe mais no GW Assistente. Sincronize novamente.');

  const currentData = row?.data || {};
  const createdAt = snapshot.createdAt || new Date().toISOString();
  // O envio visual também representa uma nova sincronização do levantamento.
  // Recriamos o pacote técnico a partir da medição local atual para que o GW Assistente
  // atualize o horário exibido e não permaneça preso ao syncedAt do envio anterior.
  const latestMeasurement = buildGwMeasurementPayload(project);
  const exportarOriginal = {
    format: 'image/jpeg',
    image: snapshot.image,
    width: Number(snapshot.width || 0),
    height: Number(snapshot.height || 0),
    rooms: Array.isArray(snapshot.rooms) ? snapshot.rooms : [],
    createdAt,
    source: 'GW Medidas · Exportar projeto',
  };
  const nextMeasurement = {
    ...(currentData?.levantamentoGW || {}),
    ...latestMeasurement,
    syncedAt: createdAt,
    exportarOriginal,
  };
  const nextData = {
    ...currentData,
    levantamentoGW: nextMeasurement,
    levantamentoGWAtualizadoEm: createdAt,
  };

  const { data: updatedRows, error: updateError } = await gwSupabase
    .from(table)
    .update({ data: nextData })
    .eq('company_id', companyId)
    .eq('source_id', sourceId)
    .select('source_id,data');
  if (updateError) throw updateError;
  const updated = Array.isArray(updatedRows) ? updatedRows[0] : updatedRows;
  if (!updated) throw new Error('O GW Assistente não confirmou a gravação. Nenhum envio foi marcado como concluído.');

  let confirmedExportAt = updated?.data?.levantamentoGW?.exportarOriginal?.createdAt || '';
  let confirmedSyncAt = updated?.data?.levantamentoGW?.syncedAt || '';
  let confirmedRootAt = updated?.data?.levantamentoGWAtualizadoEm || '';
  if (confirmedExportAt !== createdAt || confirmedSyncAt !== createdAt || confirmedRootAt !== createdAt) {
    const { data: verifyRow, error: verifyError } = await gwSupabase
      .from(table).select('source_id,data').eq('company_id', companyId).eq('source_id', sourceId).maybeSingle();
    if (verifyError) throw verifyError;
    confirmedExportAt = verifyRow?.data?.levantamentoGW?.exportarOriginal?.createdAt || '';
    confirmedSyncAt = verifyRow?.data?.levantamentoGW?.syncedAt || '';
    confirmedRootAt = verifyRow?.data?.levantamentoGWAtualizadoEm || '';
  }
  if (confirmedExportAt !== createdAt || confirmedSyncAt !== createdAt || confirmedRootAt !== createdAt) {
    throw new Error('O GW Assistente não confirmou a atualização completa do levantamento visual.');
  }

  return { sourceId, createdAt, verified: true, bytesApprox: Math.round(String(snapshot.image).length * 0.75) };
}
