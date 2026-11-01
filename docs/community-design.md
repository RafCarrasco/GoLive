# GoLive Community — arquitetura do produto

## Visão
Um Discord particular focado em lives, com experiência consistente Windows e Web.
O mesmo React deve renderizar os canais e perfis no Electron e no navegador.

## Modelo
- `community/profiles/{uid}`: nome e metadados de perfil. Futuramente login durável e avatares.
- `community/channels/{channelId}`: metadados dos canais gerenciáveis.
- `community/roles/{uid}`: owner/admin/member. Apenas owner concede admin.
- `rooms/{channelId}`: presença de sessão, ofertas, ICE e lives WebRTC.
- `community/access/{channelId}/{uid}`: futura lista de acesso por canal.
- Canais padrão: geral e competitivo.

## Segurança e rollout
Esta branch prepara UI e serviços. **Não publique regras permissivas nem ofereça administração em produção sem testes de regras**. A autenticação anônima atual não é um sistema de identidade seguro para administrar usuários, pois IDs podem mudar quando o usuário limpa dados locais. Antes de liberar controles administrativos, implementar login durável (Google/email), provisionamento seguro de owner e regras testadas no emulator. O acesso de pessoas e canais restritos deve ser validado no banco, nunca só pela interface.

## Próximos marcos
1. Perfis e navegação entre canais, sidebar com lives e presença.
2. Cadastro durável de conta e provisionamento de owner.
3. RBAC de canais/membros, convites e painel administrativo.
4. Motor de voz separado do vídeo. Ao encerrar live, não derrubar peers de voz nem lives alheias.
5. Revisão multi-peer: pares negociados por participante e mídia (evitar sobrescrever streams ao receber nova track).
6. Captura Windows por jogo; opt-in para loopback de sistema; echo cancellation para microfone; isolamento de áudio.
7. Testes de regras Firebase, testes E2E multiusuário, perfis falsos e carga de 5–20 pessoas.

## Reversecord
Referência conceitual apenas; nenhum código/biblioteca binária do projeto de engenharia reversa será incorporado.
