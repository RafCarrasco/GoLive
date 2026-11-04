// Novidades mostradas uma vez depois de atualizar (mais nova primeiro). Ao publicar uma versão,
// acrescente a entrada dela aqui com a mesma versão do package.json.
export type Release = { version: string; date: string; items: string[] };

export const CHANGELOG: Release[] = [
  {
    version: '0.3.7',
    date: '04/11/2026',
    items: ['Botão "Não achou o jogo?" no topo do seletor, nas duas abas, para ver o diagnóstico da captura.'],
  },
  {
    version: '0.3.6',
    date: '04/11/2026',
    items: [
      'Jogos que o Windows esconde da lista (Valorant e outros com anticheat) agora entram em Aplicativos.',
      'Novo "Não achou o jogo?" no seletor: mostra o que o Nimbo enxergou, com botão de copiar.',
      'Na aba Telas, a dica para transmitir o monitor do jogo quando ele não aparece.',
    ],
  },
  {
    version: '0.3.5',
    date: '04/11/2026',
    items: [
      'Jogos com anticheat (Valorant, por exemplo) aparecem no seletor, mesmo em tela cheia ou minimizados.',
      'Se o Windows não deixar pegar só o som do jogo, a live usa o som do PC (sem o Nimbo) em vez de ficar muda.',
      'Rodapé mais limpo, só com a versão do Nimbo.',
    ],
  },
  {
    version: '0.3.4',
    date: '02/11/2026',
    items: [
      'Qualidade automática: se a rede de quem assiste apertar, a live baixa a qualidade para aquela pessoa em vez de travar, e volta sozinha quando melhora.',
      'Saiu do jogo durante a live? Quem assiste vê a tela "Pausado · volta já" em vez da sua área de trabalho.',
      'Selo verde "Atualização disponível" no topo: um clique e pronto.',
      'Esta janela de novidades, que aparece uma vez depois de cada atualização.',
      'Versões novas do site aparecem na hora, sem precisar limpar cache.',
    ],
  },
  {
    version: '0.3.3',
    date: '02/11/2026',
    items: ['Ícone novo do Nimbo em todo lugar.', 'Versão no título da janela do app.'],
  },
  {
    version: '0.3.2',
    date: '02/11/2026',
    items: [
      'Jogo em tela cheia de verdade: escolha o jogo e o Nimbo transmite o monitor dele, com o som só do jogo.',
      'Aviso de atualização com a cara do Nimbo e versão no rodapé.',
    ],
  },
];

const parse = (v: string) => v.split('.').map((n) => Number(n) || 0);
export function newer(a: string, b: string) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
