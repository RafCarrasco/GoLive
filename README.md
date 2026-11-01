# GoLive

Streaming privado de tela para até 5 participantes (1 host + 4 espectadores), baseado em React, TypeScript, Firebase Spark e WebRTC P2P.

## Configuração (sem Blaze)
1. No projeto Firebase **golive-ad118**, registrar aplicativo Web e copiar os dados SDK para .env (veja .env.example).
2. Habilitar Authentication > Anonymous.
3. Criar Realtime Database e obter databaseURL.
4. Publicar database.rules.json nas regras do Realtime Database (nunca usar regras públicas).
5. Rodar npm install, npm run dev.
6. Publicar: npm run build && npx firebase-tools login && npx firebase-tools deploy --project golive-ad118 --only hosting,database.

## Limites
O navegador pede autorização para capturar tela e áudio. Áudio de sistema varia conforme SO/navegador. STUN sem TURN não garante conexões atrás de NAT restritivo. 1080p60 é meta, não garantia. Quatro espectadores podem exigir ~32Mbps de upload (8Mbps cada) + overhead. Para produção, rever controles contra abuso, segurança e confiabilidade. Não se recomenda divulgar publicamente a URL durante a fase de testes.
