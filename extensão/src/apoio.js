// O "♥ apoiar": um selinho no cabeçalho do "Onde caçar?" que abre o Pix de doação.
//
// O código Pix e o QR vêm prontos em src/pix.js (gerado por scripts/gerar-pix.mjs); sem ele,
// o selinho não aparece. A caixa abre POR CIMA do painel e dentro dele — fora, o clique nela
// contaria como "clique fora" e fecharia o painel. O QR é SVG no DOM, não `<img>`: assim a CSP
// do jogo (que manda em de onde vêm as imagens) não tem o que bloquear.
(function (root) {
  'use strict';
  const PIH = (root.__pokeidleHunt ??= {});
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function botao() {
    if (!PIH.pix) return '';
    return '<button type="button" class="pih-apoiar" data-acao="apoiar" title="Apoie o Auto Hunt com um Pix">♥ apoiar</button>';
  }

  function qrSvg() {
    const { lado, caminho } = PIH.pix;
    const m = 2; // a margem branca que todo leitor de QR precisa
    const v = lado + 2 * m;
    return `<svg class="pih-pix-qr" viewBox="${-m} ${-m} ${v} ${v}" shape-rendering="crispEdges" role="img" aria-label="QR Code do Pix">
      <rect x="${-m}" y="${-m}" width="${v}" height="${v}" fill="#fff"/><path d="${caminho}" fill="#000"/></svg>`;
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      return false;
    }
  }

  function abrir(painel) {
    painel.querySelector('.pih-apoio')?.remove();
    const caixa = document.createElement('div');
    caixa.className = 'pih-apoio';
    caixa.setAttribute('role', 'dialog');
    caixa.setAttribute('aria-label', 'Apoiar o Auto Hunt');
    caixa.innerHTML = `<div class="painel pih-apoio-cartao">
      <div class="painel-cab">
        <h3>Apoie o Auto Hunt</h3>
        <button type="button" class="btn-painel-toggle" data-apoio="fechar" title="Fechar" aria-label="Fechar">×</button>
      </div>
      <p class="auto-dica">O Auto Hunt é grátis. Se ele te ajuda, um Pix de qualquer valor mantém o projeto vivo. Obrigado! ♥</p>
      ${qrSvg()}
      <button type="button" class="pih-btn pih-pix-copiar" data-apoio="copiar">Copiar código Pix</button>
      <input class="pih-pix-codigo" type="text" readonly value="${esc(PIH.pix.codigo)}" hidden aria-label="Código Pix copia e cola">
      <p class="auto-dica pih-pix-para">Para ${esc(PIH.pix.exibir ?? PIH.pix.nome)}</p>
    </div>`;
    painel.append(caixa);

    const fechar = () => caixa.remove();
    caixa.querySelector('[data-apoio="fechar"]').addEventListener('click', fechar);
    // Clicar no fundo escuro fecha; clicar no cartão, não.
    caixa.addEventListener('click', (ev) => { if (ev.target === caixa) fechar(); });
    const bt = caixa.querySelector('[data-apoio="copiar"]');
    bt.addEventListener('click', async () => {
      if (await copiar(PIH.pix.codigo)) {
        bt.textContent = 'Copiado! Cole no app do seu banco';
        setTimeout(() => { if (bt.isConnected) bt.textContent = 'Copiar código Pix'; }, 3000);
      } else {
        // Sem acesso à área de transferência: mostra o código selecionado para copiar à mão.
        const campo = caixa.querySelector('.pih-pix-codigo');
        campo.hidden = false;
        campo.select();
        bt.textContent = 'Copie o código abaixo (Ctrl+C)';
      }
    });
    bt.focus();
  }

  /** Liga o selinho depois que o painel foi desenhado. */
  function ligar(painel) {
    painel.querySelector('[data-acao="apoiar"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      abrir(painel);
    });
  }

  PIH.apoio = { botao, ligar };
})(globalThis);
