import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  channelAllowed,
  createChannel,
  isStaff,
  removeRoomSession,
  roleLabel,
  saveProfile,
  setCategoryAccess,
  setCategoryRoles,
  setChannelAccess,
  setChannelRoles,
} from './community';
import { useAuth } from './hooks/useAuth';
import { useCommunity, useRoomsPresence } from './hooks/useCommunity';
import { useLiveRoom } from './hooks/useLiveRoom';
import { loadCaptureSettings, saveCaptureSettings, type StreamKind } from './live/capture';
import { liveKey } from './live/room';
import { signOutAccount } from './session';
import { LoadingScreen, LoginScreen, NicknameScreen, PendingScreen } from './components/AuthScreens';
import { Sidebar } from './components/Sidebar';
import { UserPanel } from './components/UserPanel';
import { Stage } from './components/Stage';
import { AdminPanel } from './components/AdminPanel';
import { NicknameForm, PermissionModal, StreamSettingsModal } from './components/Modals';
import { Modal, useDialogs } from './ui/Modal';
import { useToast } from './ui/Toast';

export default function App() {
  const auth = useAuth();
  if (!auth.ready) return <LoadingScreen />;
  if (!auth.uid) return <LoginScreen error={auth.error} />;
  if (auth.approved === null) return <LoadingScreen />;
  if (!auth.approved) return <PendingScreen email={auth.email} />;
  // key: trocar de conta remonta tudo, sem herdar sala, perfis ou cargos da conta anterior.
  return <Community key={auth.uid} uid={auth.uid} />;
}

function Community({ uid }: { uid: string }) {
  const data = useCommunity(uid);
  const toast = useToast();
  const dialogs = useDialogs();
  const role = data.roles[uid] || 'member';
  const staff = isStaff(role);
  const nickname = data.profiles[uid]?.displayName || '';

  const live = useLiveRoom(uid, {
    onIssue: (message) => toast.info(message),
    onKicked: (message) => toast.error(message),
  });
  const { snapshot } = live;
  const room = snapshot.room;

  // Lives abertas no palco, por chave "uid:screen" / "uid:camera".
  const [visible, setVisible] = useState<string[]>([]);
  const keysOf = useCallback(
    (member?: string) =>
      Object.entries(snapshot.broadcasts).flatMap(([id, kinds]) =>
        id === uid || (member && id !== member)
          ? []
          : (Object.keys(kinds) as StreamKind[]).map((kind) => liveKey(id, kind)),
      ),
    [snapshot.broadcasts, uid],
  );
  // Logo depois de entrar, as lives que já estavam no ar (ou as da pessoa escolhida) abrem sozinhas.
  // A lista do canal chega um instante depois da entrada, por isso a janela de alguns segundos.
  const autoOpen = useRef<{ until: number; member?: string }>({ until: 0 });
  useEffect(() => {
    if (Date.now() > autoOpen.current.until) return;
    const keys = keysOf(autoOpen.current.member);
    if (!keys.length) return;
    autoOpen.current.until = 0;
    setVisible((ids) => [...new Set([...ids, ...keys])].slice(0, 4));
  }, [keysOf]);
  const [adminOpen, setAdminOpen] = useState(false);
  const [permission, setPermission] = useState<{ kind: 'category' | 'channel'; id: string } | null>(null);
  const [showStreamSettings, setShowStreamSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [capture, setCapture] = useState(loadCaptureSettings);

  const allowedChannels = useMemo(
    () => Object.keys(data.channels).filter((id) => channelAllowed(id, uid, data)),
    [data, uid],
  );
  const presence = useRoomsPresence(data.loaded ? allowedChannels : []);
  const nameOf = useCallback(
    (id: string) => data.profiles[id]?.displayName || 'Participante',
    [data.profiles],
  );

  const join = useCallback(
    async (channelId: string, watch?: string) => {
      setAdminOpen(false);
      if (room === channelId) {
        if (watch) setVisible((ids) => [...new Set([...ids, ...keysOf(watch)])]);
        return;
      }
      try {
        await live.join(channelId);
        setVisible([]);
        autoOpen.current = { until: Date.now() + 5000, member: watch };
      } catch (e) {
        toast.error(e);
      }
    },
    [live, room, keysOf, toast],
  );

  // Link de convite (?room=) e reabertura da página.
  const [autoJoined, setAutoJoined] = useState(false);
  useEffect(() => {
    if (autoJoined || !data.loaded || !nickname) return;
    setAutoJoined(true);
    const target = new URLSearchParams(location.search).get('room');
    if (target && allowedChannels.includes(target)) void join(target);
    else if (target) toast.error('Você não tem acesso a este canal.');
  }, [autoJoined, data.loaded, nickname, allowedChannels, join, toast]);

  // Permissão retirada enquanto conectado: sai do canal (o servidor também já bloqueia a leitura).
  useEffect(() => {
    if (room && data.loaded && !allowedChannels.includes(room)) {
      void live.leave();
      toast.error('Você não tem mais acesso a este canal.');
    }
  }, [room, data.loaded, allowedChannels, live, toast]);

  const toggleBroadcast = async (kind: StreamKind) => {
    try {
      if (snapshot.local[kind]) {
        await live.stop(kind);
        toast.info(kind === 'camera' ? 'Webcam desligada' : 'Transmissão encerrada');
        return;
      }
      await live.start(kind, capture);
      const key = liveKey(uid, kind);
      setVisible((ids) => (ids.includes(key) ? ids : [...ids, key]));
      toast.success(kind === 'camera' ? 'Webcam ao vivo' : 'Transmissão iniciada');
    } catch (e) {
      toast.error(e);
    }
  };

  // Escolhe outra tela ou janela sem encerrar a live (como o "Trocar" do Discord).
  const swapScreen = async () => {
    try {
      await live.start('screen', capture, true);
      toast.success('Transmissão trocada');
    } catch (e) {
      toast.error(e);
    }
  };

  const createChannelIn = async (categoryId: string) => {
    const name = await dialogs.prompt({
      title: 'Novo canal',
      label: 'Nome do canal',
      confirmLabel: 'Criar',
      validate: (v) => (v.trim().length < 2 || v.trim().length > 32 ? 'Use de 2 a 32 caracteres.' : ''),
    });
    if (!name) return;
    try {
      await createChannel(uid, name, '', categoryId);
      toast.success('Canal criado');
    } catch (e) {
      toast.error(e);
    }
  };

  if (!data.loaded) return <LoadingScreen />;
  if (!nickname)
    return (
      <NicknameScreen
        onSave={async (name) => {
          await saveProfile(uid, name);
          toast.success('Perfil pronto!');
        }}
      />
    );

  const channelName = data.channels[room]?.name || room;
  const permissionLevel = permission
    ? (permission.kind === 'category' ? data.categoryAccess : data.channelAccess)[permission.id] || 'member'
    : 'member';
  const permissionName = permission
    ? (permission.kind === 'category'
        ? data.categories[permission.id]?.name
        : data.channels[permission.id]?.name) || ''
    : '';

  return (
    <div className="app">
      <Sidebar
        uid={uid}
        data={data}
        presence={presence}
        room={room}
        disabled={live.busy === 'joining'}
        adminOpen={adminOpen}
        onJoin={(id) => void join(id)}
        onWatch={(id, member) => void join(id, member)}
        onOpenAdmin={() => setAdminOpen((v) => !v)}
        onPermission={setPermission}
        onCreateChannel={(id) => void createChannelIn(id)}
        onRemoveSession={(id, member) =>
          void removeRoomSession(id, member).then(
            () => toast.success('Sessão removida'),
            (e) => toast.error(e),
          )
        }
        footer={
          <UserPanel
            channelName={channelName}
            joined={snapshot.joined}
            online={snapshot.online}
            liveKinds={{ screen: Boolean(snapshot.local.screen), camera: Boolean(snapshot.local.camera) }}
            onSwap={() => void swapScreen()}
            busy={live.busy}
            nickname={nickname}
            roleLabel={roleLabel[role]}
            onLeave={() => void live.leave()}
            onToggle={(kind) => void toggleBroadcast(kind)}
            onStreamSettings={() => setShowStreamSettings(true)}
            onInvite={() =>
              void navigator.clipboard.writeText(`${location.origin}/?room=${encodeURIComponent(room)}`).then(
                () => toast.success('Convite copiado'),
                (e) => toast.error(e),
              )
            }
            onProfile={() => setShowProfile(true)}
            onSignOut={() => void live.leave().then(() => signOutAccount())}
          />
        }
      />
      <main className="content">
        {adminOpen && staff ? (
          <AdminPanel
            uid={uid}
            data={data}
            onClose={() => setAdminOpen(false)}
            onPermission={setPermission}
            onCreateChannel={(id) => void createChannelIn(id)}
          />
        ) : snapshot.joined ? (
          <Stage
            uid={uid}
            channelName={channelName}
            live={snapshot}
            visible={visible}
            setVisible={setVisible}
            nameOf={nameOf}
            onRetry={live.retry}
          />
        ) : (
          <div className="home">
            <img src="/nimbo-mascot.svg" alt="" />
            <h1>Olá, {nickname}</h1>
            <p className="muted">Escolha um canal na barra lateral para assistir às lives ou transmitir.</p>
          </div>
        )}
      </main>

      {permission && (
        <PermissionModal
          key={permission.kind + permission.id}
          title={(permission.kind === 'category' ? 'Categoria ' : 'Canal ') + permissionName}
          kind={permission.kind}
          current={permissionLevel}
          allowOwner={role === 'owner'}
          roleDefs={data.roleDefs}
          selectedRoles={
            (permission.kind === 'category' ? data.categoryRoles : data.channelRoles)[permission.id] || []
          }
          canEditRoles={role === 'owner'}
          onClose={() => setPermission(null)}
          onSave={async (level) => {
            try {
              if (permission.kind === 'category') await setCategoryAccess(permission.id, level);
              else await setChannelAccess(permission.id, level);
              toast.success('Permissão atualizada');
            } catch (e) {
              toast.error(e);
            }
          }}
          onSaveRoles={async (roleIds) => {
            try {
              if (permission.kind === 'category') await setCategoryRoles(permission.id, roleIds);
              else await setChannelRoles(permission.id, roleIds);
              toast.success('Cargos atualizados');
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      )}
      {showStreamSettings && (
        <StreamSettingsModal
          settings={capture}
          live={Object.keys(snapshot.local).length > 0}
          onChange={(next) => {
            setCapture(next);
            saveCaptureSettings(next);
          }}
          onClose={() => setShowStreamSettings(false)}
        />
      )}
      {showProfile && (
        <Modal title="Seu perfil" kicker="CONTA" size="sm" onClose={() => setShowProfile(false)}>
          <NicknameForm
            initial={nickname}
            submitLabel="Salvar"
            onSubmit={async (name) => {
              await saveProfile(uid, name);
              toast.success('Perfil atualizado');
              setShowProfile(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
