// Auto Hunt — fica sempre na melhor hunt (ou zera a Pokédex) e repõe bolas, poções e revives.
//
// As decisões por trás de cada regra estão em docs/skillz/decisions/2026-10-17-auto-hunt.md e,
// para o Modo Pokédex, em docs/skillz/decisions/2026-10-17-zerar-pokedex.md.
// Em resumo: a melhor hunt é o topo do ranking do /hunt, com as mesmas preferências do painel
// (D-01, D-08, D-10), e a troca acontece sempre que o topo muda (D-09). A compra segue
// "abaixo de X, compra até Y" por item, sem passar da reserva de ouro (D-06), e reage assim que
// o estoque cai (D-16). Os Termos do pokeidle.io (seção 5) permitem automação que siga as
// regras de quem joga na mão, por isso: nada de trocar com as travas do servidor fechadas, no
// centro ou no Safari (D-07), e um freio fixo no envio (D-14). Quando algo não dá certo, não há
// aviso: tenta de novo depois (D-04).
(function (root) {
  'use strict';
  const PIH = (root.__pokeidleHunt ??= {});
  if (!PIH.on || !PIH.enviar) return;

  const CHAVE_CFG = 'pokeidle-hunt:auto:v2';
  const AVALIAR_A_CADA_MS = 30_000;
  const INTERVALO_MIN_MS = 3000; // entre dois comandos quaisquer
  const MAX_POR_HORA = 60; // o Modo Pokédex troca de hunt, de pokémon e religa o arremesso a cada espécie
  const PORTA_HUNT_MS = 12_000; // o servidor recusa trocar nos 10 s seguintes à última entrada
  const FOLGA_TRAVA_MS = 500; // margem sobre a trava de combate, contra atraso de rede
  // Troca enviada e a hunt não mudou (o servidor recusou): tenta de novo depois de 5 s, 10 s,
  // 20 s, 40 s e, daí em diante, 60 s, para não gastar o freio quando ele insiste em recusar.
  const ESPERA_HUNT_MIN_MS = 5000;
  const ESPERA_HUNT_MAX_MS = 60_000;
  const ESPERA_COMPRA_MS = 15_000; // compra enviada e o estoque não subiu: tenta de novo depois disto
  const ESPERA_AJUSTE_MS = 10_000; // troca de pokémon ou de automação enviada: espera antes de repetir
  const CHECAR_A_CADA_MS = 1000; // o estado chega várias vezes por segundo; estoque e Pokédex são olhados no máx. 1×/s

  // Os sprites das bolas, os mesmos do cliente (`SPRITE_BOLA` no app.js do jogo). Caminho sem
  // barra inicial vive em /assets/.
  const SPRITE_BOLA = {
    1: 'site/assets/ui/ball-poke.png',
    2: 'site/assets/ui/ball-great.png',
    3: '/img/ball-super.png',
    4: 'site/assets/ui/ball-ultra.png',
    5: '/img/ball-beast.png',
  };
  const ICONE_GENERICO = 'site/assets/ui/menu-bolsa.png';
  const srcIcone = (rel) => (String(rel).startsWith('/') ? rel : `/assets/${rel}`);

  // modo: 'melhor' | 'pokedex'. pokedexAntes: o arremesso e o pokémon em campo de antes do Modo
  // Pokédex mexer neles, para devolver quando ele sair (D-09); fica salvo para sobreviver a um F5.
  const PADRAO = { ligado: false, modo: 'melhor', reservaOuro: 5000, regras: {}, pokedexAntes: null };
  const lerJson = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
  const salvo = lerJson(CHAVE_CFG, {});
  const cfg = { ...PADRAO, ...salvo, regras: { ...salvo.regras } };
  const gravarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch { /* sem armazenamento */ } };

  const nf = new Intl.NumberFormat('pt-BR');
  const num = (v) => nf.format(Math.round(Number(v) || 0));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const regiao = (r) => (r ? r[0].toUpperCase() + r.slice(1) : '');
  const duracao = (ms) => {
    const min = Math.floor(ms / 60_000);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  };

  // ---- o que o jogo diz ------------------------------------------------------------------
  let welcome = null;
  let eu = null;
  let loja = null; // o catálogo da loja, montado depois da primeira carga
  let huntAtual = null;
  let entrouEm = 0; // quando a hunt atual começou (relógio local)
  // As travas vêm no relógio do servidor. Cada estado que chega com um `servidorAgora` novo
  // acerta a diferença para o relógio daqui.
  let desvio = 0;
  let ultimoServidorAgora = null;
  const agoraServidor = () => Date.now() + desvio;
  let ultimaChecagem = 0;
  let huntDesejada = null; // a hunt para onde ir, se não for a atual
  let tentativasHunt = 0; // trocas enviadas para a hunt desejada sem a hunt mudar
  let alvoDasTentativas = null;
  let alarmeTrava = null; // dispara quando a trava de 3 s vence

  // O campo da hunt: quais selvagens estão vivos, pelos pacotes `campo.init` e `campo` (as
  // chaves curtas são as do jogo, como em geo.js: `s` slot, `x` morto, `fora` slots que saíram).
  // `viuSelvagem`: só depois de ver selvagem nesta hunt o campo vazio quer dizer "entre ondas";
  // no Modo Economia do jogo o servidor não manda selvagem nenhum, e o campo vazio não diz nada.
  const vivos = new Map(); // slot → vivo?
  let viuSelvagem = false;
  const naoSelvagem = (m) => m.bn || m.ti !== undefined || m.cura || m.tm || m.depot || m.tr;
  function aplicarCampo(m) {
    for (const x of m?.mobs ?? []) {
      if (naoSelvagem(x)) continue;
      viuSelvagem = true;
      if (x.x) vivos.set(x.s, false);
      else if (x.x === false || !vivos.has(x.s)) vivos.set(x.s, true);
    }
    for (const slot of m?.fora ?? []) vivos.delete(slot);
  }
  const campoSemVivo = () => viuSelvagem && ![...vivos.values()].some(Boolean);

  PIH.on('welcome', (m) => { welcome = m; loja = null; });
  PIH.on('campo.init', (m) => {
    vivos.clear();
    viuSelvagem = false;
    aplicarCampo(m);
    tentarTrocarHunt();
  });
  PIH.on('campo', (m) => {
    aplicarCampo(m);
    tentarTrocarHunt(); // chega várias vezes por segundo: é ele que pega a janela entre ondas
  });
  PIH.on('estado', (e) => {
    eu = e;
    if (e?.servidorAgora && e.servidorAgora !== ultimoServidorAgora) {
      ultimoServidorAgora = e.servidorAgora;
      desvio = e.servidorAgora - Date.now();
    }
    if ((e?.huntSlug ?? null) !== huntAtual) {
      huntAtual = e?.huntSlug ?? null;
      entrouEm = Date.now();
      tentativasHunt = 0;
    }
    tentarTrocarHunt();
    if (Date.now() - ultimaChecagem >= CHECAR_A_CADA_MS) {
      ultimaChecagem = Date.now();
      tentarPokedex();
      comprarSePreciso().catch((err) => console.error('[auto-hunt]', err));
    }
  });

  // ---- envio, com freio ------------------------------------------------------------------
  const enviados = []; // horários dos envios da última hora
  function enviar(msg) {
    const agora = Date.now();
    while (enviados.length && agora - enviados[0] > 3_600_000) enviados.shift();
    if (enviados.length >= MAX_POR_HORA) return false;
    if (enviados.length && agora - enviados.at(-1) < INTERVALO_MIN_MS) return false;
    if (!PIH.enviar(msg)) return false; // conexão fechada: tenta depois
    enviados.push(agora);
    return true;
  }

  const proxima = new Map(); // chave do comando → quando pode repetir
  /** Envia, e não repete o mesmo tipo de comando antes de `esperaMs`. */
  function enviarComEspera(chave, msg, esperaMs) {
    if ((proxima.get(chave) ?? 0) > Date.now()) return false;
    if (!enviar(msg)) return false;
    proxima.set(chave, Date.now() + esperaMs);
    return true;
  }

  // ---- a loja ----------------------------------------------------------------------------
  /** Tudo o que o Market vende, na ordem dele: bolas compráveis, poções e revives. */
  function catalogoDaLoja(jogo) {
    const bolas = (welcome?.catalogoBolas ?? [])
      .filter((b) => b.compravel && b.priceGold > 0)
      .sort((a, b) => a.priceGold - b.priceGold)
      .map((b) => ({
        chave: `ball:${b.id}`, kind: 'ball', id: b.id, nome: b.nome, preco: b.priceGold, grupo: 'Bolas',
        icone: srcIcone(SPRITE_BOLA[b.id] ?? SPRITE_BOLA[1]),
      }));
    // Os itens "nossos" do jogo (Golden Potion…) chegam pelo welcome e entram no mesmo mapa,
    // como no cliente oficial; o ícone deles vem junto, os outros saem do items-icons.json.
    const porId = new Map();
    for (const i of jogo?.itens ?? []) porId.set(i.id, i);
    for (const i of welcome?.itensNossos ?? []) porId.set(i.id, i);
    const itens = [...porId.values()]
      .filter((i) => (i.category === 'heal' || i.category === 'revive') && Number(i.npcPrice) > 0)
      .sort((a, b) => (a.category === b.category ? a.npcPrice - b.npcPrice : a.category === 'heal' ? -1 : 1))
      .map((i) => ({
        chave: `item:${i.id}`, kind: 'item', id: i.id, nome: i.name, preco: Number(i.npcPrice),
        grupo: i.category === 'heal' ? 'Poções' : 'Revives',
        icone: srcIcone(jogo?.icones?.[i.id] ?? i.icon ?? ICONE_GENERICO),
      }));
    return [...bolas, ...itens];
  }
  const tenho = (p) => Number((p.kind === 'ball' ? eu?.balls : eu?.items)?.[p.id]) || 0;

  /**
   * A primeira compra que as regras pedem agora, ou null. `pendente` é a compra já enviada e
   * ainda não entregue: o item dela fica de fora e o custo dela já sai do ouro livre, para a
   * reserva valer mesmo antes do estado novo chegar.
   */
  function decidirCompra(loja, pendente = null) {
    let ouroLivre = (Number(eu?.gold) || 0) - (Number(cfg.reservaOuro) || 0) - (pendente?.custo ?? 0);
    for (const p of loja) {
      const r = cfg.regras[p.chave];
      if (!(r?.min > 0)) continue;
      if (p.chave === pendente?.item.chave) continue;
      const tem = tenho(p);
      if (tem >= r.min) continue;
      const qty = Math.min(r.alvo - tem, Math.floor(ouroLivre / p.preco));
      if (qty < 1) continue; // sem ouro acima da reserva para este: tenta o próximo item
      return { item: p, tinha: tem, custo: qty * p.preco, msg: { t: 'shop.buy', kind: p.kind, id: p.id, qty } };
    }
    return null;
  }

  // ---- a compra, assim que o estoque cai (D-16) ------------------------------------------
  let aguardando = null; // { item, tinha, custo, ate }: a compra enviada, até o estoque dela subir

  async function comprarSePreciso() {
    if (!cfg.ligado || !welcome || !eu) return;
    loja ??= catalogoDaLoja(await PIH.carregarJogo());
    // O estoque subiu (a compra passou) ou a espera venceu (o servidor recusou): a fila anda.
    if (aguardando && (tenho(aguardando.item) > aguardando.tinha || Date.now() >= aguardando.ate)) aguardando = null;
    const compra = decidirCompra(loja, aguardando);
    if (compra && enviar(compra.msg)) {
      aguardando = { item: compra.item, tinha: compra.tinha, custo: compra.custo, ate: Date.now() + ESPERA_COMPRA_MS };
    }
  }

  // ---- Modo Pokédex ----------------------------------------------------------------------
  // Vai de hunt em hunt capturando o que falta na Pokédex (D-01 a D-09 do log do modo). Quem
  // arremessa é o "Lançar até Capturar" do jogo (VIP); a extensão escolhe a hunt, põe em campo o
  // melhor pokémon da equipe para ela e religa o arremesso, que para sozinho a cada captura.
  let dex = null; // shared/pokedex.mjs do jogo
  let plano = null; // { total, pegas, fila: [{ slug, nome, nivel, regiao, pk, kph, faltam }], atual }

  const ehVip = () => !!eu?.loja?.vip;
  const modoPokedex = () => cfg.modo === 'pokedex' && ehVip();
  const huntPorSlug = (slug) => (welcome?.hunts ?? []).find((h) => h.slug === slug) ?? null;
  /** A chave da espécie na Pokédex, pelo módulo do jogo; null se ela não conta na Pokédex. */
  const chaveDex = (pokeId) => {
    const k = dex.chavePokedex(pokeId);
    return k == null ? null : String(k);
  };

  /** As chaves da Pokédex com pelo menos uma captura. */
  function capturadas() {
    const entradas = dex.normalizarEntradasPokedex?.(eu?.pokedex) ?? eu?.pokedex ?? {};
    const pegas = new Set();
    for (const [k, v] of Object.entries(entradas)) if (Number(v?.c) > 0) pegas.add(String(k));
    return pegas;
  }
  const faltando = (hunt, pegas) => (hunt?.especies ?? []).filter((e) => {
    const k = chaveDex(e.pokeId);
    return k != null && !pegas.has(k);
  });

  /**
   * A fila: hunts liberadas com espécie faltando que algum pokémon da equipe mata (D-03), cada
   * uma com o pokémon que mata mais rápido ali (D-04), das mais rápidas para as mais lentas (D-05).
   */
  async function planejarPokedex() {
    dex ??= (await PIH.carregarJogo()).mod.pokedex;
    const pegas = capturadas();
    const equipe = (eu?.pokemons ?? []).filter((p) => p.slot != null && p.stats);
    const melhorPorHunt = new Map(); // slug → { pk, kph, linha }
    for (const pk of equipe) {
      let r = null;
      try { r = await PIH.analisarPokemon?.(pk, { soLiberadas: true }); } catch (err) { console.warn('[auto-hunt]', pk.nome, err); }
      for (const l of r?.linhas ?? []) {
        if (l.inviavel || !(l.kph > 0)) continue;
        const m = melhorPorHunt.get(l.slug);
        if (!m || l.kph > m.kph) melhorPorHunt.set(l.slug, { pk, kph: l.kph, linha: l });
      }
    }
    // O progresso conta todas as espécies das hunts liberadas, mesmo as que a equipe ainda não mata.
    const nivel = Number(eu?.level) || 0;
    const todas = new Set();
    for (const h of welcome?.hunts ?? []) {
      if ((h.nivel ?? 0) > nivel) continue;
      for (const e of h.especies ?? []) {
        const k = chaveDex(e.pokeId);
        if (k != null) todas.add(k);
      }
    }
    const fila = [...melhorPorHunt.values()]
      .map(({ pk, kph, linha }) => ({
        slug: linha.slug, nome: linha.nome, nivel: linha.nivel, regiao: linha.regiao, pk, kph,
        faltam: faltando(linha.hunt ?? huntPorSlug(linha.slug), pegas).length,
      }))
      .filter((h) => h.faltam > 0)
      .sort((a, b) => b.kph - a.kph);
    // Fica na hunt atual enquanto faltar espécie nela (D-06); senão, a primeira da fila.
    const atual = fila.find((h) => h.slug === huntAtual) ?? fila[0] ?? null;
    return { total: todas.size, pegas: [...todas].filter((k) => pegas.has(k)).length, fila, atual };
  }

  /** Na hunt da fila: põe o pokémon certo em campo e religa o "Lançar até Capturar". */
  function tentarPokedex() {
    if (!cfg.ligado || !modoPokedex()) { restaurarAntes(); return; }
    const alvo = plano?.atual;
    if (!alvo || !dex || !eu || huntAtual !== alvo.slug) return;
    if (eu.noCentro || eu.safari?.dentro || eu.casa?.dentro || eu.boss?.arena) return;
    // Pegou tudo daqui (a Pokédex de agora, não a do plano de até 30 s atrás): próxima hunt.
    if (!faltando(huntPorSlug(alvo.slug), capturadas()).length) {
      plano.atual = null;
      setTimeout(avaliar, 300);
      return;
    }
    if (!cfg.pokedexAntes) {
      cfg.pokedexAntes = {
        ateCapturar: !!eu.automation?.autoBallAteCapturar,
        semParar: !!eu.automation?.autoBallSemParar,
        activeId: eu.activeId ?? null,
      };
      gravarCfg();
    }
    if (eu.activeId !== alvo.pk.id) {
      enviarComEspera('ativo', { t: 'team.active', pokemonId: alvo.pk.id }, ESPERA_AJUSTE_MS);
      return;
    }
    if (!eu.automation?.autoBallAteCapturar) {
      enviarComEspera('arremesso', { t: 'auto.set', ...eu.automation, autoBallAteCapturar: true, autoBallSemParar: false }, ESPERA_AJUSTE_MS);
    }
  }

  /** Saiu do Modo Pokédex: devolve o arremesso e o pokémon em campo de antes, um comando por vez. */
  function restaurarAntes() {
    const a = cfg.pokedexAntes;
    if (!a || !eu?.automation) return;
    const auto = eu.automation;
    if (!!auto.autoBallAteCapturar !== a.ateCapturar || !!auto.autoBallSemParar !== a.semParar) {
      enviarComEspera('arremesso', { t: 'auto.set', ...auto, autoBallAteCapturar: a.ateCapturar, autoBallSemParar: a.semParar }, ESPERA_AJUSTE_MS);
      return;
    }
    if (a.activeId != null && eu.activeId !== a.activeId && eu.pokemons?.some((p) => p.id === a.activeId)) {
      enviarComEspera('ativo', { t: 'team.active', pokemonId: a.activeId }, ESPERA_AJUSTE_MS);
      return;
    }
    cfg.pokedexAntes = null;
    gravarCfg();
  }

  // ---- a hunt ----------------------------------------------------------------------------

  async function decidirHunt() {
    if (modoPokedex()) {
      plano = await planejarPokedex();
      atualizarProgresso();
      if (plano.atual) {
        huntDesejada = plano.atual.slug !== huntAtual ? plano.atual.slug : null;
        return;
      }
      // Nada a capturar nas hunts que a equipe mata: segue na melhor hunt e retoma sozinho
      // quando aparecer espécie nova (D-07).
      restaurarAntes();
    } else {
      plano = null;
    }
    // `soLiberadas`: o servidor recusa hunt acima do nível do treinador.
    const r = await PIH.analisarAtivo?.({ soLiberadas: true });
    const topo = r?.linhas?.[0];
    huntDesejada = topo && !topo.inviavel && topo.slug !== huntAtual ? topo.slug : null;
  }

  /**
   * A saída da hunt está liberada agora? A mesma regra do jogo (`huntSaidaLivreAgora` no cliente
   * dele): livre na hora entre ondas (nenhum selvagem vivo) e logo depois do respawn, antes do
   * primeiro golpe da onda nova; fora disso, só 3 s depois do último dano trocado.
   */
  function saidaLivre() {
    if (campoSemVivo()) return true;
    if ((Number(eu.combateOndaSeq) || 0) < (Number(eu.ondaSeq) || 0)) return true;
    return agoraServidor() >= (Number(eu.centroLivreEm) || 0) + FOLGA_TRAVA_MS;
  }

  /** Manda a troca pendente se nada a impede agora. Roda a cada estado e a cada pacote de campo. */
  function tentarTrocarHunt() {
    if (!cfg.ligado || !huntDesejada || !eu || !huntAtual) return;
    if (huntDesejada === huntAtual) { huntDesejada = null; tentativasHunt = 0; return; }
    if (eu.noCentro || eu.safari?.dentro || eu.casa?.dentro || eu.boss?.arena) return;
    if (Date.now() - entrouEm < PORTA_HUNT_MS) return;
    if (!saidaLivre()) {
      // Ninguém avisa quando os 3 s vencem (nessa hora não chega abate, ouro nem XP): um alarme avisa.
      const falta = (Number(eu.centroLivreEm) || 0) + FOLGA_TRAVA_MS - agoraServidor();
      if (falta > 0 && falta < 10_000 && !alarmeTrava) {
        alarmeTrava = setTimeout(() => { alarmeTrava = null; tentarTrocarHunt(); }, falta + 50);
      }
      return;
    }
    if (alvoDasTentativas !== huntDesejada) { alvoDasTentativas = huntDesejada; tentativasHunt = 0; }
    const espera = Math.min(ESPERA_HUNT_MAX_MS, ESPERA_HUNT_MIN_MS * 2 ** tentativasHunt);
    if (enviarComEspera(`hunt:${huntDesejada}`, { t: 'hunt.select', slug: huntDesejada }, espera)) tentativasHunt++;
  }

  // ---- o ciclo ---------------------------------------------------------------------------
  // A hunt é reavaliada a cada 30 s (rodar o ranking custa); a compra roda aqui também, como
  // rede de segurança para quando nenhum estado chegar.
  let avaliando = false;
  async function avaliar() {
    if (!welcome || !eu || avaliando) return;
    if (!cfg.ligado) { restaurarAntes(); return; }
    avaliando = true;
    try {
      await decidirHunt();
      tentarTrocarHunt();
      tentarPokedex();
      await comprarSePreciso();
    } catch (err) {
      console.error('[auto-hunt]', err);
    } finally {
      avaliando = false;
    }
  }
  setInterval(avaliar, AVALIAR_A_CADA_MS);

  // ---- o bloco no painel "Onde caçar?" (D-11) --------------------------------------------
  // Feito com as classes do próprio jogo (`.painel`, `.painel-cab`, `.btn-painel-toggle`,
  // `.auto-linha`, `.auto-chip`, `.auto-dica`, `.selo-vip`) para ser igual ao painel de
  // Automações e mudar junto quando o jogo mudar o visual. O interruptor é o
  // `input[type=checkbox]` global dele.
  let configAberta = false;

  const CHEVRON = '<svg class="ico-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z" fill="currentColor"/></svg>';

  function linhaItem(p) {
    const r = cfg.regras[p.chave] ?? { min: 0, alvo: 0 };
    const tem = tenho(p);
    const ativo = r.min > 0;
    return `<div class="pih-auto-item${ativo ? '' : ' pih-auto-off'}">
      <span class="auto-chip${ativo ? ' on' : ''}${tem ? '' : ' vazio'}" title="${esc(p.nome)} · ${num(p.preco)} de ouro">
        <img src="${esc(p.icone)}" alt="" width="18" height="18" loading="lazy"><span class="q">${num(tem)}</span>
      </span>
      <span class="pih-auto-nome">${esc(p.nome)}<small>${num(p.preco)} de ouro</small></span>
      <label class="pih-auto-campo"><span>abaixo de</span><input type="number" min="0" inputmode="numeric" data-regra="${p.chave}" data-campo="min" value="${r.min}"></label>
      <label class="pih-auto-campo"><span>compra até</span><input type="number" min="0" inputmode="numeric" data-regra="${p.chave}" data-campo="alvo" value="${r.alvo}"></label>
    </div>`;
  }

  function listaLoja(itens) {
    const grupos = [];
    for (const p of itens) {
      if (grupos.at(-1)?.nome !== p.grupo) grupos.push({ nome: p.grupo, itens: [] });
      grupos.at(-1).itens.push(p);
    }
    return grupos.map((g) => `<div class="pih-auto-grupo">
      <div class="auto-rotulo">${esc(g.nome)}</div>
      ${g.itens.map(linhaItem).join('')}
    </div>`).join('');
  }

  /** O progresso do Modo Pokédex (D-08). */
  function htmlProgresso() {
    if (!ehVip()) return '<p class="auto-dica">O Modo Pokédex usa o "Lançar até Capturar" do jogo, que é do VIP.</p>';
    if (!plano) return `<p class="auto-dica">${cfg.ligado ? 'Montando a fila da Pokédex…' : 'Ligue a automação para começar.'}</p>`;
    const pct = plano.total ? Math.round((plano.pegas / plano.total) * 100) : 0;
    const a = plano.atual;
    const proximas = plano.fila.filter((h) => h !== a);
    const tempo = a && huntAtual === a.slug ? ` · há ${duracao(Date.now() - entrouEm)}` : '';
    return `<div class="pih-auto-dex-topo"><b>Pokédex: ${num(plano.pegas)} de ${num(plano.total)}</b> <span class="pih-dim">nas hunts liberadas</span></div>
      <div class="pih-auto-barra" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i><span>${pct}%</span></div>
      ${a
        ? `<div>Agora: <b>${esc(a.nome)}</b> <span class="pih-dim">${esc(regiao(a.regiao))} · Nv ${num(a.nivel)}</span> · ${esc(a.pk.nome)}${tempo}</div>`
        : '<div>Nada a capturar nas hunts que a equipe mata: seguindo na melhor hunt.</div>'}
      ${proximas.length ? `<div class="pih-dim">Próximas: ${proximas.slice(0, 3).map((h) => esc(h.nome)).join(', ')}${proximas.length > 3 ? ` e mais ${num(proximas.length - 3)}` : ''}</div>` : ''}`;
  }

  /** Redesenha só o progresso, se o painel estiver aberto. */
  function atualizarProgresso() {
    const el = root.document?.querySelector('.pih-auto [data-auto="pokedex"]');
    if (el) el.innerHTML = htmlProgresso();
  }

  function blocoModo() {
    const vip = ehVip();
    const pokedex = cfg.modo === 'pokedex';
    return `<div class="pih-auto-modo">
        <span class="auto-rotulo">Modo</span>
        <span class="pih-seg">
          <button type="button" data-modo="melhor" class="${pokedex ? '' : 'on'}">Melhor hunt</button>
          <button type="button" data-modo="pokedex" class="${pokedex ? 'on' : ''}"${vip ? '' : ' disabled title="Requer VIP: usa o Lançar até Capturar do jogo"'}>Pokédex</button>
        </span>
        <span class="selo-vip" title="O Modo Pokédex requer VIP">VIP</span>
      </div>
      <div class="pih-auto-pokedex" data-auto="pokedex"${pokedex ? '' : ' hidden'}>${htmlProgresso()}</div>`;
  }

  /** O HTML do bloco Auto Hunt. `jogo` (o catálogo carregado) pode faltar no começo. */
  function blocoPainel(jogo) {
    const itens = jogo ? catalogoDaLoja(jogo) : [];
    return `<div class="painel pih-auto${configAberta ? '' : ' recolhida'}">
      <div class="painel-cab">
        <h3>Automação <span class="cnt" data-auto="rotulo">${cfg.ligado ? 'ligada' : 'desligada'}</span></h3>
        <button type="button" class="btn-painel-toggle" data-auto="configurar" aria-expanded="${configAberta}"
          title="${configAberta ? 'Recolher' : 'Configurar compras'}">${CHEVRON}</button>
      </div>
      <label class="auto-linha"><input type="checkbox" data-auto="ligado" ${cfg.ligado ? 'checked' : ''}> Trocar de hunt e repor o estoque sozinho</label>
      ${blocoModo()}
      <div class="pih-auto-config" ${configAberta ? '' : 'hidden'}>
        <p class="auto-dica">Para cada item: quando ficar abaixo do primeiro número, compra até o segundo. 0 ignora o item.</p>
        <label class="pih-auto-reserva"><span>Guardar sempre</span>
          <input type="number" min="0" step="100" inputmode="numeric" data-auto="reserva" value="${cfg.reservaOuro}"><span>de ouro</span></label>
        ${itens.length ? listaLoja(itens) : '<p class="auto-dica">Carregando a loja do jogo…</p>'}
      </div>
    </div>`;
  }

  /** Liga os controles do bloco depois que o painel foi desenhado. */
  function ligarPainel(painel) {
    const bloco = painel.querySelector('.pih-auto');
    if (!bloco) return;
    // Sem `onerror` no HTML: a CSP do jogo bloqueia manipulador inline.
    for (const img of bloco.querySelectorAll('.auto-chip img')) {
      img.addEventListener('error', () => { img.src = srcIcone(ICONE_GENERICO); }, { once: true });
    }
    const liga = bloco.querySelector('[data-auto="ligado"]');
    liga?.addEventListener('change', () => {
      cfg.ligado = liga.checked;
      gravarCfg();
      bloco.querySelector('[data-auto="rotulo"]').textContent = cfg.ligado ? 'ligada' : 'desligada';
      if (!cfg.ligado) { huntDesejada = null; plano = null; }
      atualizarProgresso();
      setTimeout(avaliar, 300); // ligado, começa já; desligado, devolve o que o Modo Pokédex mudou
    });
    for (const b of bloco.querySelectorAll('[data-modo]')) {
      b.addEventListener('click', () => {
        if (b.disabled || cfg.modo === b.dataset.modo) return;
        cfg.modo = b.dataset.modo;
        gravarCfg();
        plano = null;
        huntDesejada = null;
        for (const outro of bloco.querySelectorAll('[data-modo]')) outro.classList.toggle('on', outro === b);
        bloco.querySelector('[data-auto="pokedex"]').hidden = cfg.modo !== 'pokedex';
        atualizarProgresso();
        setTimeout(avaliar, 300);
      });
    }
    const botao = bloco.querySelector('[data-auto="configurar"]');
    botao?.addEventListener('click', () => {
      configAberta = !configAberta;
      bloco.classList.toggle('recolhida', !configAberta);
      bloco.querySelector('.pih-auto-config').hidden = !configAberta;
      botao.setAttribute('aria-expanded', String(configAberta));
      botao.title = configAberta ? 'Recolher' : 'Configurar compras';
    });
    const reserva = bloco.querySelector('[data-auto="reserva"]');
    reserva?.addEventListener('change', () => {
      cfg.reservaOuro = Math.max(0, Math.round(Number(reserva.value) || 0));
      reserva.value = cfg.reservaOuro;
      gravarCfg();
    });
    for (const el of bloco.querySelectorAll('[data-regra]')) {
      el.addEventListener('change', () => {
        const r = (cfg.regras[el.dataset.regra] ??= { min: 0, alvo: 0 });
        r[el.dataset.campo] = Math.max(0, Math.round(Number(el.value) || 0));
        el.value = r[el.dataset.campo];
        if (r.alvo < r.min) {
          r.alvo = r.min;
          const alvo = bloco.querySelector(`[data-regra="${el.dataset.regra}"][data-campo="alvo"]`);
          if (alvo) alvo.value = r.alvo;
        }
        gravarCfg();
        // O chip acende quando o item passa a ser reposto, como na escolha das Automações.
        const linha = el.closest('.pih-auto-item');
        linha?.classList.toggle('pih-auto-off', !(r.min > 0));
        linha?.querySelector('.auto-chip')?.classList.toggle('on', r.min > 0);
        if (r.min > 0) comprarSePreciso().catch((err) => console.error('[auto-hunt]', err));
      });
    }
  }

  PIH.auto = {
    blocoPainel, ligarPainel, avaliar, cfg,
    _interno: { catalogoDaLoja, decidirCompra, tentarTrocarHunt, comprarSePreciso, planejarPokedex, tentarPokedex, plano: () => plano },
  };
})(globalThis);
