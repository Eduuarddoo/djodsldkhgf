// A tela: o botão Auto Hunt ao lado do nome do pokémon em campo e o painel "Onde caçar?".
//
// O card "Em campo" do jogo (`#ativo-card`) é redesenhado inteiro a cada atualização do
// estado. Por isso a barra Auto Hunt NÃO mora dentro dele: fica no painel em volta (`#p-ativo`),
// que não é redesenhado, logo antes do card — no fluxo, acima do pokémon, na largura da caixa.
//
// Ao abrir o jogo, a extensão confere onde está o pokémon ativo. Se o card não estiver onde
// esperamos (layout novo do jogo), ela pede um clique nele e lembra a escolha.
(function (root) {
  'use strict';
  const PIH = (root.__pokeidleHunt ??= {});
  if (!PIH.on || !PIH.engine) return;

  const CHAVE_PREFS = 'pokeidle-hunt:prefs:v1';
  const CHAVE_ALVO = 'pokeidle-hunt:alvo:v1';
  const POR_PAGINA = 25;

  const lerJson = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
  const gravarJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

  let prefs = { ordem: 'xp', soLiberadas: true, comPocao: true, ...lerJson(CHAVE_PREFS, {}) };
  let welcome = null;
  let eu = null;

  // ---- formatação ------------------------------------------------------------------------
  const nf = new Intl.NumberFormat('pt-BR');
  const nfc = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
  const num = (v) => nf.format(Math.round(v));
  const curto = (v) => (Math.abs(v) >= 10000 ? nfc.format(v) : num(v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const REGIAO = { kanto: 'Kanto', johto: 'Johto', outland: 'Outland', orre: 'Orre', hoenn: 'Hoenn', sinnoh: 'Sinnoh', unova: 'Unova', kalos: 'Kalos', alola: 'Alola', galar: 'Galar', paldea: 'Paldea' };
  const regiao = (r) => REGIAO[r] ?? (r ? r[0].toUpperCase() + r.slice(1) : '');
  const segundos = (s) => (s < 1 ? '<1 s' : s < 60 ? `${s.toFixed(1).replace('.', ',')} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

  const pkAtivo = () => eu?.pokemons?.find((p) => p.id === eu.activeId) ?? null;

  // ---- o botão ---------------------------------------------------------------------------
  function criarBotao(extra = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pih-btn ${extra}`.trim();
    b.textContent = 'Auto Hunt';
    return b;
  }

  const botao = criarBotao('pih-barra');
  botao.title = 'Onde caçar? — as melhores hunts para o seu pokémon em campo';
  botao.setAttribute('aria-label', botao.title);
  botao.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    alternarPainel();
  });

  let alvoManual = lerJson(CHAVE_ALVO, null); // seletor escolhido pelo jogador, se o padrão falhar

  function ancora() {
    if (alvoManual) {
      const el = document.querySelector(alvoManual);
      if (el) return { modo: 'manual', el };
    }
    const card = document.getElementById('ativo-card');
    const painel = document.getElementById('p-ativo');
    const nome = card?.querySelector('.ativo-nome');
    if (card && painel && nome && !card.classList.contains('vazio')) return { modo: 'padrao', card, nome };
    return null;
  }

  let quadro = 0;
  function posicionarBotao() {
    cancelAnimationFrame(quadro);
    quadro = requestAnimationFrame(() => {
      const a = ancora();
      if (!a) { botao.hidden = true; return; }
      botao.hidden = false;
      if (a.modo === 'padrao') {
        botao.classList.remove('pih-fixo');
        botao.classList.add('pih-barra');
        botao.style.left = botao.style.top = botao.style.width = '';
        if (a.card.previousElementSibling !== botao) a.card.before(botao);
      } else {
        // Reserva: flutua logo acima do ponto que o jogador apontou.
        botao.classList.remove('pih-barra');
        botao.classList.add('pih-fixo');
        if (botao.parentElement !== document.body) document.body.appendChild(botao);
        const r = a.el.getBoundingClientRect();
        botao.style.left = `${r.left}px`;
        botao.style.top = `${Math.max(4, r.top - botao.offsetHeight - 6)}px`;
      }
    });
  }

  function vigiarCard() {
    const painel = document.getElementById('p-ativo') ?? document.body;
    new MutationObserver(posicionarBotao).observe(painel, { childList: true, subtree: true });
    addEventListener('resize', posicionarBotao);
    addEventListener('scroll', posicionarBotao, true);
    // Rede de segurança para mudanças de layout que não mexem no card (abrir/fechar painéis).
    setInterval(posicionarBotao, 1500);
  }

  // ---- verificação: onde está o pokémon ativo? -------------------------------------------
  let aviso = null;
  function mostrarAviso(html, { fechaEm = 0, acao = null } = {}) {
    aviso?.remove();
    aviso = document.createElement('div');
    aviso.className = 'pih-aviso';
    aviso.append(criarBotao());
    const txt = document.createElement('div');
    txt.innerHTML = html;
    aviso.append(txt);
    if (acao) aviso.append(acao);
    const x = document.createElement('button');
    x.className = 'pih-x';
    x.textContent = '×';
    x.onclick = () => { aviso?.remove(); aviso = null; pararMira(); };
    aviso.append(x);
    document.body.append(aviso);
    if (fechaEm) setTimeout(() => { if (aviso?.contains(txt)) { aviso.remove(); aviso = null; } }, fechaEm);
  }

  let verificado = false;
  function verificar(tentativa = 0) {
    if (verificado || !eu) return;
    const pk = pkAtivo();
    if (!pk) {
      if (tentativa === 0) mostrarAviso('Coloque um pokémon <b>em campo</b> para usar o <b>Auto Hunt</b>.', { fechaEm: 8000 });
      setTimeout(() => verificar(1), 3000);
      return;
    }
    const a = ancora();
    const texto = a?.modo === 'padrao' ? a.nome.textContent : a?.el?.textContent;
    if (a && texto?.includes(pk.nome)) {
      verificado = true;
      posicionarBotao();
      mostrarAviso(`Pokémon em campo encontrado: <b>${esc(pk.nome)}</b>. O <b>Auto Hunt</b> está logo acima dele.`, { fechaEm: 4500 });
      return;
    }
    if (tentativa < 12) { setTimeout(() => verificar(tentativa + 1), 500); return; }
    const mirar = document.createElement('button');
    mirar.className = 'pih-mais';
    mirar.style.width = 'auto';
    mirar.textContent = 'Apontar';
    mirar.onclick = iniciarMira;
    mostrarAviso(`<b>Onde está seu Pokémon ativo?</b><br>Não achei o card de <b>${esc(pk.nome)}</b>. Clique em “Apontar” e depois no nome dele.`, { acao: mirar });
  }

  let mirando = null;
  function iniciarMira() {
    document.documentElement.classList.add('pih-mirando');
    let marcado = null;
    const sobre = (ev) => {
      marcado?.classList.remove('pih-alvo');
      marcado = ev.target instanceof Element && !ev.target.closest('.pih-aviso') ? ev.target : null;
      marcado?.classList.add('pih-alvo');
    };
    const clique = (ev) => {
      if (!marcado) return;
      ev.preventDefault();
      ev.stopPropagation();
      alvoManual = seletorDe(marcado);
      gravarJson(CHAVE_ALVO, alvoManual);
      pararMira();
      verificado = true;
      posicionarBotao();
      mostrarAviso('Pronto: o <b>Auto Hunt</b> vai ficar logo acima deste ponto.', { fechaEm: 4000 });
    };
    addEventListener('mouseover', sobre, true);
    addEventListener('click', clique, true);
    mirando = () => {
      removeEventListener('mouseover', sobre, true);
      removeEventListener('click', clique, true);
      marcado?.classList.remove('pih-alvo');
    };
  }
  function pararMira() {
    document.documentElement.classList.remove('pih-mirando');
    mirando?.();
    mirando = null;
  }
  function seletorDe(el) {
    const partes = [];
    while (el && el !== document.body) {
      if (el.id) { partes.unshift(`#${CSS.escape(el.id)}`); break; }
      const i = [...el.parentElement.children].indexOf(el) + 1;
      partes.unshift(`${el.tagName.toLowerCase()}:nth-child(${i})`);
      el = el.parentElement;
    }
    return partes.join(' > ');
  }

  // ---- o painel --------------------------------------------------------------------------
  let painel = null;
  let mostrando = POR_PAGINA;
  let assinatura = '';

  function alternarPainel() {
    if (painel) return fecharPainel();
    painel = document.createElement('div');
    painel.className = 'pih-painel';
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Onde caçar?');
    document.body.append(painel);
    mostrando = POR_PAGINA;
    posicionarPainel();
    desenhar();
    addEventListener('keydown', aoTeclar, true);
    setTimeout(() => addEventListener('pointerdown', aoClicarFora, true));
  }
  function fecharPainel() {
    painel?.remove();
    painel = null;
    assinatura = '';
    removeEventListener('keydown', aoTeclar, true);
    removeEventListener('pointerdown', aoClicarFora, true);
  }
  const aoTeclar = (ev) => { if (ev.key === 'Escape') fecharPainel(); };
  const aoClicarFora = (ev) => { if (painel && !painel.contains(ev.target) && ev.target !== botao) fecharPainel(); };

  function posicionarPainel() {
    if (!painel) return;
    const base = document.getElementById('p-ativo')?.getBoundingClientRect() ?? botao.getBoundingClientRect();
    const larg = painel.offsetWidth || 640;
    let left = base.right + 10;
    if (left + larg > innerWidth - 8) left = Math.max(8, innerWidth - larg - 8);
    const top = Math.min(Math.max(8, base.top - 60), Math.max(8, innerHeight - painel.offsetHeight - 8));
    painel.style.left = `${left}px`;
    painel.style.top = `${top}px`;
  }

  function cabecalho(pk) {
    const q = Number(pk?.quality ?? pk?.qualidade);
    const iv = pk?.ivs ? Object.values(pk.ivs).reduce((s, x) => s + (Number(x) || 0), 0) : null;
    const sub = pk
      ? [esc(pk.nome), `Nv ${num(pk.level)}`, `P${pk.potencia ?? 1}`, Number.isFinite(q) ? `Q ${q.toFixed(3).replace('.', ',')}` : '', iv != null ? `IV ${iv}` : '',
        PIH.engine._interno.temAoe(pk) ? 'TM AoE' : '']
        .filter(Boolean).join(' · ')
      : 'nenhum pokémon em campo';
    return `<div class="pih-cab">
      <span class="pih-btn" aria-hidden="true">Auto Hunt</span>
      <div class="pih-titulo"><h3>Onde caçar? <span class="pih-credito">made by Zennex</span>${PIH.apoio?.botao() ?? ''}</h3><small>${sub}</small></div>
      <button type="button" class="pih-fechar" data-acao="fechar" title="Fechar (Esc)">×</button>
    </div>`;
  }

  function blocoStats(pk) {
    if (!pk?.stats) return '';
    const rot = [['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['spAtk', 'SP.ATK'], ['spDef', 'SP.DEF'], ['speed', 'SPD']];
    return `<div class="pih-vao pih-stats">${rot.map(([k, r]) => `
      <div class="pih-stat"><b>${r}</b><span>${num(pk.stats[k] ?? 0)}</span>${pk.ivs?.[k] != null ? `<i>IV ${pk.ivs[k]}</i>` : ''}</div>`).join('')}
    </div>`;
  }

  /** Os bônus de XP que entraram na conta (multiplicam-se, como no jogo). */
  function blocoBonus(b) {
    if (!b) return '';
    const x = (v) => `×${v.toFixed(2).replace('.', ',')}`;
    const fmt = (i) => `${esc(i.nome)} ${i.mult >= 2 ? x(i.mult) : `+${(Math.round((i.mult - 1) * 1000) / 10).toString().replace('.', ',')}%`}`;
    const lista = b.itens.length ? b.itens.map(fmt).join(' · ') : 'nenhum bônus ativo';
    const iguais = Math.abs(b.pokemon - b.treinador) < 1e-6;
    return `<div class="pih-vao pih-bonus" title="Os bônus se multiplicam entre si (Pokepédia → Níveis e XP)">
      <b>Bônus de XP:</b> ${lista}
      <span class="pih-bonus-total">${iguais ? x(b.pokemon) : `pokémon ${x(b.pokemon)} · treinador ${x(b.treinador)}`}</span>
    </div>`;
  }

  function controles() {
    return `<div class="pih-ctrl">
      <span class="pih-seg">
        <button type="button" data-ordem="xp" class="${prefs.ordem === 'xp' ? 'on' : ''}">XP/h</button>
        <button type="button" data-ordem="ouro" class="${prefs.ordem === 'ouro' ? 'on' : ''}">Ouro/h</button>
      </span>
      <label><input type="checkbox" data-pref="soLiberadas" ${prefs.soLiberadas ? 'checked' : ''}> só hunts liberadas</label>
      <label title="Com a automação de poção ligada, só morre quem leva um golpe maior que o HP inteiro"><input type="checkbox" data-pref="comPocao" ${prefs.comPocao ? 'checked' : ''}> poção automática</label>
      ${prefs.ordem === 'ouro' ? '<button type="button" class="pih-ajuda" data-acao="ajuda-ouro" aria-expanded="false" aria-controls="pih-dica-ouro" title="O que entra no ouro/h">?</button>' : ''}
    </div>
    ${prefs.ordem === 'ouro' ? `<div class="pih-vao pih-dica" id="pih-dica-ouro" hidden>
      O ouro/h soma o <b>ouro de cada abate</b> e o <b>loot</b> vendido ao NPC.
      A <b>venda dos pokémon capturados</b> não entra no cálculo.
    </div>` : ''}`;
  }

  function risco(l) {
    if (l.umHit) return '<span class="pih-perigo" title="Um golpe do selvagem passa do seu HP">☠ 1 hit</span>';
    if (l.mortesH >= 0.5) return `<span class="pih-perigo" title="Mortes estimadas por hora">☠ ${l.mortesH.toFixed(1).replace('.', ',')}/h</span>`;
    const pct = Math.round(l.hitPct * 100);
    const oque = l.engajados > 1.2
      ? `O pior momento (o golpe mais forte de um selvagem mais o golpe médio dos outros ${(l.engajados - 1).toFixed(1).replace('.', ',')} que o AoE segura em você) tira ${pct}% do seu HP`
      : `O pior golpe do selvagem tira ${pct}% do seu HP`;
    if (pct >= 50) return `<span class="pih-alerta" title="${oque}">⚠ ${pct}%</span>`;
    return `<span class="pih-ok" title="${oque}">✓ ${pct}%</span>`;
  }

  function linhaHtml(l, i) {
    const medido = l.kphMedido != null ? ` · você fez ${num(l.kphMedido)} abates/h aqui com este pokémon (referência; não muda o ranking)` : '';
    const aprox = l.aoe
      ? `<span class="pih-aprox" title="Estimativa com o TM AoE: ${l.engajados.toFixed(1).replace('.', ',')} selvagens em você ao mesmo tempo${l.geoMedida ? '' : '; geometria padrão'}${medido}">≈AoE</span>`
      : l.geoMedida
        ? (medido ? `<span class="pih-medido" title="Geometria medida em ondas cheias${medido}">●</span>` : '')
        : `<span class="pih-aprox" title="Geometria padrão (sem onda cheia medida nesta hunt)${medido}">≈</span>`;
    const cls = [i === 0 && !l.inviavel ? 'pih-top' : '', l.liberada ? '' : 'pih-bloq'].filter(Boolean).join(' ');
    const golpe = l.melhorGolpe ? `${esc(l.melhorGolpe.nome)} ×${l.efetividade.toFixed(2).replace('.', ',')}` : '';
    if (l.inviavel) {
      return `<tr class="${cls}"><td class="pih-pos">${i + 1}</td>
        <td class="pih-hunt"><b>${esc(l.nome)}</b><small>${regiao(l.regiao)} · Nv ${num(l.nivel)}</small></td>
        <td colspan="5"><span class="pih-perigo">não mata o selvagem</span></td></tr>`;
    }
    return `<tr class="${cls}" title="${esc(golpe)}">
      <td class="pih-pos">${i + 1}</td>
      <td class="pih-hunt"><b>${esc(l.nome)}</b><small>${regiao(l.regiao)} · Nv ${num(l.nivel)}${l.liberada ? '' : ' · 🔒'}</small></td>
      <td>${curto(prefs.ordem === 'ouro' ? l.ouroH : l.xpPokemonH)}</td>
      <td>${aprox}${num(l.kph)}</td>
      <td>${segundos(l.ttk)}</td>
      <td>${risco(l)}</td>
      <td>${curto(prefs.ordem === 'ouro' ? l.xpPokemonH : l.ouroH)}</td>
    </tr>`;
  }

  function corpo(r, jogo) {
    const linhas = r.linhas;
    if (!linhas.length) return '<div class="pih-erro">Nenhuma hunt liberada para o seu nível de treinador.</div>';
    const top = linhas.find((l) => !l.inviavel);
    const outro = prefs.ordem === 'ouro' ? 'XP/h' : 'Ouro/h';
    const melhor = top ? `<div class="pih-vao pih-melhor">
        <span class="pih-coroa">👑</span>
        <div><strong>${esc(top.nome)}</strong> <span class="pih-dim">${regiao(top.regiao)} · Nv ${num(top.nivel)}</span><br>
        ${curto(top.xpPokemonH)} XP/h do pokémon · ${curto(top.xpTreinadorH)} XP/h do treinador · ${curto(top.ouroH)} ouro/h · ${num(top.kph)} abates/h${top.melhorGolpe ? ` · ${esc(top.melhorGolpe.nome)}` : ''}</div>
      </div>` : '';
    return `${melhor}
      <div class="pih-vao pih-lista"><table class="pih-tab">
        <thead><tr><th>#</th><th>Hunt</th><th>${prefs.ordem === 'ouro' ? 'Ouro/h' : 'XP/h'}</th><th>Abates/h</th><th>Mata em</th><th>Risco</th><th>${outro}</th></tr></thead>
        <tbody>${linhas.slice(0, mostrando).map(linhaHtml).join('')}</tbody>
      </table>
      ${linhas.length > mostrando ? `<button type="button" class="pih-mais" data-acao="mais">mostrar mais (${linhas.length - mostrando})</button>` : ''}
      </div>
      <div class="pih-rodape">Dados do jogo ${jogo.versao ? `v${esc(jogo.versao)}` : 'no ar'} · ${r.linhas.length} de ${r.total} hunts · cálculo em ${r.ms} ms · ranking com ondas cheias · geometria medida em ${PIH.geo?.huntsMedidas?.() ?? 0} hunts (≈ = padrão · ● = você já caçou aqui, passe o mouse)${r.aoe ? ` · TM AoE: até ${r.aoe.engajadosMax} selvagens no quadrado ao mesmo tempo` : ''}</div>`;
  }

  // A linha do Auto Hunt (auto.js) fica no topo do painel, logo abaixo do cabeçalho.
  const linhaAuto = (jogo) => PIH.auto?.blocoPainel(jogo) ?? '';

  async function desenhar() {
    if (!painel) return;
    const pk = pkAtivo();
    if (!welcome || !eu) {
      painel.innerHTML = `${cabecalho(pk)}${linhaAuto(null)}<div class="pih-carga">Esperando o jogo conectar…</div>`;
      ligarEventos();
      return;
    }
    if (!pk) {
      painel.innerHTML = `${cabecalho(null)}${linhaAuto(null)}<div class="pih-erro">Coloque um pokémon em campo para ver onde caçar.</div>`;
      ligarEventos();
      return;
    }
    painel.innerHTML = `${cabecalho(pk)}${linhaAuto(null)}${blocoStats(pk)}${controles()}<div class="pih-carga">Lendo o jogo…</div>`;
    ligarEventos();
    posicionarPainel();
    try {
      const jogo = await PIH.carregarJogo();
      if (!painel) return;
      const r = PIH.engine.analisar(pk, contexto(jogo, pk), prefs);
      painel.innerHTML = `${cabecalho(r.pokemon)}${linhaAuto(jogo)}${blocoStats(r.pokemon)}${blocoBonus(r.bonusXp)}${controles()}${corpo(r, jogo)}`;
      assinatura = assinaturaDe(pk);
    } catch (err) {
      console.error('[pokeidle-hunt]', err);
      if (!painel) return;
      painel.innerHTML = `${cabecalho(pk)}${linhaAuto(null)}<div class="pih-erro">Não consegui calcular: ${esc(err.message)}</div>`;
    }
    ligarEventos();
    posicionarPainel();
  }

  function contexto(jogo, pk) {
    const chave = PIH.geo?.chaveDoPokemon(pk);
    const precoItem = new Map(jogo.precoItem);
    for (const i of welcome.itensNossos ?? []) {
      if (i?.name && Number(i.npcPrice) > 0) precoItem.set(i.name, Number(i.npcPrice));
    }
    return {
      mod: jogo.mod,
      especies: jogo.especies,
      precoItem,
      hunts: welcome.hunts ?? [],
      consts: {
        tabelaTipos: welcome.tabelaTipos,
        ampliacaoHunt: welcome.ampliacaoHunt,
        multHpSelvagem: welcome.multHpSelvagem,
        multDanoSelvagem: welcome.multDanoSelvagem,
        tiposBoost: welcome.tiposBoost,
      },
      eu,
      geo: (slug) => PIH.geo?.daHunt(slug) ?? null,
      ritmoMedido: (slug) => (chave ? PIH.geo?.ritmoMedido(slug, chave) ?? null : null),
    };
  }

  function ligarEventos() {
    if (!painel) return;
    painel.querySelector('[data-acao="fechar"]')?.addEventListener('click', fecharPainel);
    PIH.auto?.ligarPainel(painel);
    PIH.apoio?.ligar(painel);
    painel.querySelector('[data-acao="mais"]')?.addEventListener('click', () => { mostrando += POR_PAGINA; desenhar(); });
    const ajuda = painel.querySelector('[data-acao="ajuda-ouro"]');
    ajuda?.addEventListener('click', () => {
      const dica = painel.querySelector('#pih-dica-ouro');
      dica.hidden = !dica.hidden;
      ajuda.setAttribute('aria-expanded', String(!dica.hidden));
    });
    for (const b of painel.querySelectorAll('[data-ordem]')) {
      b.addEventListener('click', () => { prefs.ordem = b.dataset.ordem; gravarJson(CHAVE_PREFS, prefs); desenhar(); });
    }
    for (const c of painel.querySelectorAll('[data-pref]')) {
      c.addEventListener('change', () => { prefs[c.dataset.pref] = c.checked; gravarJson(CHAVE_PREFS, prefs); desenhar(); });
    }
  }

  /**
   * O mesmo ranking do painel, com as mesmas preferências (XP/h ou Ouro/h, poção automática),
   * para o Auto Hunt (auto.js); `extra` só sobrepõe. null enquanto o jogo não conectou.
   */
  PIH.analisarAtivo = (extra = {}) => PIH.analisarPokemon(pkAtivo(), extra);
  /** O mesmo ranking para qualquer pokémon do jogador (o Modo Pokédex testa a equipe toda). */
  PIH.analisarPokemon = async (pk, extra = {}) => {
    if (!welcome || !eu || !pk) return null;
    const jogo = await PIH.carregarJogo();
    return PIH.engine.analisar(pk, contexto(jogo, pk), { ...prefs, ...extra });
  };

  // Recalcula com o painel aberto só quando muda o que entra na conta (outro pokémon, nível
  // novo, refino, TM) — não a cada golpe recebido.
  const assinaturaDe = (pk) => (pk ? `${pk.id}|${pk.level}|${pk.tmElemental ?? ''}|${pk.tmAoe ?? ''}|${JSON.stringify(pk.stats)}` : '');

  // ---- ligação com o jogo ----------------------------------------------------------------
  function preaquecer() {
    const ocioso = root.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    ocioso(() => PIH.carregarJogo().catch((err) => console.warn('[pokeidle-hunt] pré-carga falhou', err)));
  }

  PIH.on('welcome', (m) => {
    welcome = m;
    preaquecer();
  });
  PIH.on('estado', (e) => {
    const primeiro = !eu;
    eu = e;
    posicionarBotao();
    if (primeiro) setTimeout(() => verificar(0), 800);
    if (painel && assinatura && assinaturaDe(pkAtivo()) !== assinatura) desenhar();
  });

  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', vigiarCard, { once: true });
  else vigiarCard();
})(globalThis);
