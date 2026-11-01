# GoLive Community — checklist antes da primeira release privada

O código de login e autorização está na branch `feat/private-community-live-experience`.

Para abrir a comunidade com segurança:
1. Ativar Email/Password no Firebase Authentication.
2. Cadastrar a conta de proprietário no app de testes.
3. Usando o console administrativo Firebase, marcar `community/approved/<UID>` como `true` e `community/roles/<UID>` como `owner`.
4. Aplicar as regras da branch ao Realtime Database **somente junto de uma atualização do aplicativo**. As regras bloqueiam o app público antigo, que ainda usa autenticação anônima.
5. Testar usuário desconhecido, usuário aguardando aprovação, membro aprovado, administrador e proprietário.
6. Validar remoção de aprovação, entrada nos canais e leitura direta do RTDB via SDK.
7. Testar captura de CS2, eco, duas lives e múltiplos usuários no Windows.
8. Somente após a validação, publicar o site atualizado e criar release.

Não usar foto de perfil no Firebase Storage. Usar avatares de texto ou ícones locais.
Não existe chamada de voz ou chat nesta fase.

**Limitações atuais:** ainda faltam gerenciamento completo de convites, banimento com UI, permissões por canal, detecção nativa de jogos e otimização dinâmica de bitrate. P2P pode exigir TURN em algumas redes.
