# gg.bet live monitor

Монитор лайв-счёта и коэффициентов на gg.bet: CS2, League of Legends, Dota 2,
Valorant, теннис и настольный теннис.

## Как устроен сайт

Страница не отдаёт данные в HTML — всё приезжает по **двум GraphQL-вебсокетам**:

| Поток | Что отдаёт |
|---|---|
| `wss://gg-b-gql.gg.bet/graphql` | линия, рынки, коэффициенты |
| `wss://score-board.databet.cloud/graphql` | детальное состояние матча: карта, раунд, бомба, таймер |

HTTP-запросы к `gg.bet/graphql` — только конфиги, локали и баннеры; матчей там нет.

Оба сокета говорят в конверте `subscriptions-transport-ws`:

```json
{ "id": "3", "type": "data", "payload": { "data": { "onUpdateSportEvent": { ... } } } }
```

Полезные поля внутри `data`:

| Поле | Смысл |
|---|---|
| `matches.sportEvents` | полный снапшот линии, приходит один раз при подписке |
| `onUpdateSportEvent` | инкрементальный патч: счёт и коэффициенты |
| `onUpdateSportEventOverviews.replace` | состояние матча от databet |

**Главная тонкость.** В патчах `onUpdateSportEvent` у команд есть только `id`,
без названий — имена приходят один раз в снапшоте. Поэтому патчи имеют смысл
только вместе со снапшотом, и `MatchStore` их сливает.

**Связка потоков.** Id матча у gg.bet выглядит как `5:dbe576ca-…`, у databet —
`dbe576ca-…`, без префикса провайдера. Отсюда `normalizeId()`.

## Виды спорта

Каждый вид спорта — отдельная страница со своими подписками, поэтому монитор
открывает по вкладке на каждый и сливает всё в одно хранилище.

| Ключ | sportId | Название |
|---|---|---|
| `cs` | `esports_counter_strike` | Counter-Strike |
| `lol` | `esports_league_of_legends` | League of Legends |
| `dota` | `esports_dota_2` | Dota 2 |
| `valorant` | `esports_valorant` | Valorant |
| `tennis` | `tennis` | Теннис |
| `table_tennis` | `table_tennis` | Настольный теннис |

Идентификаторы взяты не наугад, а из ответа `categorizerSportList` в
`samples/0021-ws.json`. Любой другой `sportId` тоже можно передать напрямую.

```bash
node src/monitor.mjs --sport cs,lol,dota,valorant,tennis
node src/monitor.mjs --sport all
```

## Два файла на выходе

`odds-history.csv` отвечает на вопрос «какая была цена в момент T» — строка на
каждое изменение коэффициента:

```csv
ts,sport,match_id,title,map_score,current_map,round_score,market,selection,price,is_active
```

`changes.csv` отвечает на другой вопрос — «что происходило» — и складывает все
события матча в один упорядоченный поток:

```csv
ts,sport,match_id,title,kind,target,from,to
"2026-08-23T19:09:11Z","esports_counter_strike","c5715a56…","Fokus vs BakS","score","","0:0","1:0"
"2026-08-23T19:09:26Z","esports_counter_strike","c5715a56…","Fokus vs BakS","price","Победитель / Fokus","1.82","1.81"
```

Виды событий:

| `kind` | Когда пишется |
|---|---|
| `match_start` | матч появился и стало известно, кто играет |
| `score` | изменился счёт по картам/сетам |
| `map`, `map_name` | сменилась карта |
| `round` | сменился раунд |
| `state` | сменилось состояние (`freeze_time`, `live_time`, …) |
| `bet_stop` | приём ставок остановлен или возобновлён |
| `price` | сдвинулся коэффициент |
| `odd_suspended`, `odd_resumed` | исход сняли с продажи или вернули |
| `market_open`, `market_closed` | рынок появился или пропал |

## Требования

- Node.js 20+
- Регион, из которого gg.bet открывается. Сайт отдаёт `403 This internet site is
  not accepting visitors from your region` на уровне Cloudflare, до загрузки JS.
  Если нужен прокси — флаг `--proxy`.

## Установка

```bash
npm install
npx playwright install chromium
```

## Использование

```bash
npm test          # парсер и журнал изменений на записях из samples/ — без сети
npm run watch     # живая таблица, odds-history.csv и changes.csv
npm run discover  # снять свежие сырые ответы в captures/
npm run inspect   # разобрать, что нападало в captures/
```

Вывод `watch`:

```
gg.bet · CS2 live · 19:06:28
==========================================================================

Evil Ghost vs WhiteThunder   maps 1:0
  Ultras League
  map 2 · 11:13 · round 1 · freeze_time
  Победитель:
     Evil Ghost                 1.64
   ^ WhiteThunder               2.12

1WIN vs Locura Gatos   maps 0:0
  Intel Extreme Masters Beijing 2026: Global Open Qualifier
  map 1 · de_ancient · 9:0 · round 10 · freeze_time
  Победитель:
     1WIN                       1.00  (suspended)
     Locura Gatos               14.00
```

`^` / `v` — движение коэффициента с прошлой отрисовки.

Матч попадает в таблицу и в CSV только после того, как придёт снапшот с
названиями команд: патчи `onUpdateSportEvent` несут одни id, и записывать их
рано. Если браузер падает или страница закрывается, монитор пишет причину и
поднимает новую сессию — накопленные матчи при этом сохраняются.

История пишется в CSV по строке на **каждое изменение** цены:

```csv
ts,match_id,title,map_score,current_map,round_score,market,selection,price,is_active
2026-08-23T19:06:28.114Z,dbe576ca-…,1WIN vs Locura Gatos,0:0,1,9:0,Победитель,Locura Gatos,14,true
```

## Флаги

| Флаг | Назначение |
|---|---|
| `--discover` | режим захвата сырых payload'ов |
| `--url <url>` | другая страница (по умолчанию — лайв CS) |
| `--interval <sec>` | период перерисовки, по умолчанию 5 |
| `--out <file>` | файл истории, по умолчанию `odds-history.csv` |
| `--proxy <server>` | `http://user:pass@host:port` |
| `--headful` | показать окно браузера |
| `--once` | не перезапускать сессию после падения |

## Структура

| Файл | Что делает |
|---|---|
| `src/parse.mjs` | разбор кадров и `MatchStore` — слияние снапшота, патчей и счёта |
| `src/changes.mjs` | сравнение двух состояний матча → записи журнала |
| `src/sports.mjs` | реестр видов спорта и их `sportId` |
| `src/render.mjs` | отрисовка таблицы (без браузера, поэтому тестируема) |
| `src/monitor.mjs` | Playwright, перехват вебсокетов, CSV |
| `src/inspect.mjs` | разбор захваченных payload'ов: рейтинг и скелет |
| `src/parse.test.mjs` | тесты парсера на реальных записях из `samples/` |
| `src/changes.test.mjs` | тесты журнала изменений |
| `samples/` | 99 записанных кадров живой сессии — фикстуры для тестов |

## Разбор нового поля

1. `npm run discover` — снять свежие кадры
2. `npm run inspect` — найти файл с нужными данными
3. `node src/inspect.mjs <файл>` — посмотреть скелет структуры
4. добавить поле в `eventOf()` или `MatchStore#list()` в `src/parse.mjs`
5. `npm test` — убедиться, что старые записи всё ещё разбираются

## Что пока не проверено на живых данных

Записи в `samples/` сняты только с Counter-Strike. Детальное состояние матча
(карта, раунд, бомба) приходит от `score-board.databet.cloud` в типе
`CSGOOverview`; у LoL, Dota, Valorant и тенниса структура наверняка другая —
свои поля вместо карт и раундов.

Счёт, турнир, названия команд, рынки и коэффициенты берутся из общего для всех
видов спорта `fixture`, поэтому работать должны сразу. А вот строка состояния
для остальных видов спорта, скорее всего, окажется пустой, пока не снят захват
и не разобраны их типы овервью:

```bash
rm -rf captures && node src/monitor.mjs --sport lol,dota,tennis --discover
npm run inspect
```

## Оговорка

Автоматический сбор котировок обычно противоречит пользовательскому соглашению
букмекера. Проверьте условия gg.bet перед регулярным использованием.
