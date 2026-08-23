# gg.bet CS2 live monitor

Монитор лайв-счёта и коэффициентов по Counter-Strike на gg.bet.

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
npm test          # прогон парсера по реальным записям из samples/ — без сети
npm run watch     # живая таблица + история в odds-history.csv
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

## Структура

| Файл | Что делает |
|---|---|
| `src/parse.mjs` | разбор кадров и `MatchStore` — слияние снапшота, патчей и счёта |
| `src/render.mjs` | отрисовка таблицы (без браузера, поэтому тестируема) |
| `src/monitor.mjs` | Playwright, перехват вебсокетов, CSV |
| `src/inspect.mjs` | разбор захваченных payload'ов: рейтинг и скелет |
| `src/parse.test.mjs` | тесты на реальных записях из `samples/` |
| `samples/` | 99 записанных кадров живой сессии — фикстуры для тестов |

## Разбор нового поля

1. `npm run discover` — снять свежие кадры
2. `npm run inspect` — найти файл с нужными данными
3. `node src/inspect.mjs <файл>` — посмотреть скелет структуры
4. добавить поле в `eventOf()` или `MatchStore#list()` в `src/parse.mjs`
5. `npm test` — убедиться, что старые записи всё ещё разбираются

## Оговорка

Автоматический сбор котировок обычно противоречит пользовательскому соглашению
букмекера. Проверьте условия gg.bet перед регулярным использованием.
