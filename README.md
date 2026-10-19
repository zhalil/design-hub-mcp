# Design Hub MCP

Один MCP-сервер для Claude Code, который объединяет:

- **OpenDesign** — 150+ дизайн-систем (`DESIGN.md` + токены), 110+ шаблонов под тип результата (лендинг, дашборд, мобилка, слайды) и craft-правила (anti-AI-slop, типографика, цвет, laws of UX);
- **huashu-design** — скилл «арт-директора»: три направления до начала работы, правила вкуса, references, критика;
- **UI UX Pro Max** — поисковый движок по стилям, палитрам, шрифтам, UX-правилам и правилам стеков.

Сверху — **холст в стиле Superdesign**, локальный веб-сервер с живым превью. Каждый дизайн — фрейм. Итерации раскладываются деревом. Правки отправляются Claude прямо из браузера.

**Только Claude Code, без API-ключей.** Design Hub сам не обращается ни к одной модели. Всю работу делает Claude Code под вашей подпиской:

- интерактивная сессия (CLI, IDE, вкладка Code в Claude Desktop);
- или фоновый `claude -p`, который хаб запускает, когда вы пишете в холсте, а сессия не слушает.

Из окружения фонового запуска удаляются `ANTHROPIC_API_KEY` и `ANTHROPIC_AUTH_TOKEN`, поэтому он не может уйти в оплату по API.

Все источники — git-репозитории из `sources.json`. Скиллы, правила, системы и шаблоны индексируются из них динамически и обновляются вместе с родительскими репозиториями.

```
Claude Code (CLI / IDE / Desktop) ──stdio──► design-hub (MCP)
claude -p (фоновый, ваша подписка) ──HTTP /mcp + токен──► тот же процесс
                         ├─ catalog ◄── ~/.design-hub/vendor/{open-design, huashu-design, ui-ux-pro-max}  (git, обновляются)
                         │            ◄── ~/.design-hub/overrides/{systems,templates,skills,rules,references}  (ваше, не затирается)
                         ├─ style engine (UI UX Pro Max, python)
                         ├─ lint/screenshots (установленный Chrome/Edge по DevTools protocol)
                         └─ preview http://127.0.0.1:7777 ◄──► браузер: холст, запросы, отчёты критики
                                       ▲ live reload (SSE) · очередь запросов ◄── canvas_wait_feedback
```

## Установка как плагин Claude Code (через GitHub)

Репозиторий — одновременно плагин и маркетплейс Claude Code (`.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`).

Нужны:

- **Claude Code** с входом по подписке (`claude`, затем `/login`);
- **Node.js 20+** и **git**;
- **Python 3** — для UI UX Pro Max;
- **Chrome или Edge** — для скриншотов и линта.

В сессии Claude Code (можно и полной ссылкой `https://github.com/zhalil/design-hub-mcp`):

```
/plugin marketplace add https://github.com/zhalil/design-hub-mcp
/plugin install design-hub@design-hub
/reload-plugins
```

С Claude Code 2.1.275 и новее то же самое одной командой: `/plugin install design-hub --marketplace zhalil/design-hub-mcp`.

Из терминала: `claude plugin marketplace add zhalil/design-hub-mcp`, затем `claude plugin install design-hub@design-hub`.

Что произойдёт:

- Claude Code склонирует репозиторий и сам поставит npm-зависимости по `package-lock.json`;
- подключится MCP-сервер `design-hub` (его инструменты называются `mcp__plugin_design-hub_design-hub__*`);
- появятся скиллы `/design-hub:design`, `/design-hub:canvas`, `/design-hub:update`;
- при первом вызове сервер склонирует OpenDesign, huashu-design и UI UX Pro Max в `~/.design-hub/vendor` (около 10 секунд).

**Настройки:** `/plugin configure design-hub@design-hub` или `/config`:

- когда открывать браузер;
- фоновые запуски Claude Code;
- модель для фоновых запусков;
- порт холста.

**Без подтверждений:** чтобы Claude не спрашивал разрешения на каждый инструмент, добавьте в `~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__plugin_design-hub_design-hub"] } }
```

**Приватный репозиторий:**

- Claude Code использует ваши git-учётные данные (SSH-ключ или сохранённый HTTPS-логин): `gh auth login`, затем `gh auth setup-git`.
- Если SSH-ключа для GitHub нет, задайте `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`.

### Обновление плагина

- **Автоматически:** `/plugin` → **Marketplaces** → `design-hub` → **Enable auto-update**.
- **Вручную:** `/plugin marketplace update design-hub`, затем `claude plugin update design-hub@design-hub` и `/reload-plugins`.

В `plugin.json` намеренно нет `version`: версией служит коммит, поэтому любой push в репозиторий — это обновление. Если нужны релизы, добавьте `"version"` и меняйте его при каждом выпуске.

Обновление контента из OpenDesign, huashu и UI UX Pro Max — отдельная вещь, см. «Обновление из родительских репозиториев» ниже.

### Опубликовать свой репозиторий

```powershell
cd design-hub-mcp                     # распакованный архив, в нём уже есть git-история
git remote add origin https://github.com/zhalil/design-hub-mcp.git
git push -u origin main
```

Перед публикацией поменяйте `author` / `owner` в `.claude-plugin/*.json`. Проверка: `claude plugin validate .`. Предупреждение про отсутствующий `version` ожидаемо.

### Другие способы подключения

**Локальная папка без GitHub.** Плагин грузится прямо из папки, поэтому изменения видны после `/reload-plugins`:

```
claude plugin marketplace add C:\tools\design-hub-mcp
claude plugin install design-hub@design-hub
```

Зависимости в этом режиме Claude Code не ставит. Сервер сам выполнит `npm ci` при первом запуске, или запустите `npm install` заранее.

**Только на одну сессию** (для разработки): `claude --plugin-dir C:\tools\design-hub-mcp`.

**Как обычный MCP-сервер, без плагина:**

```powershell
npm install
node cli/design-hub.js setup          # клонирует источники заранее
node cli/design-hub.js register       # = claude mcp add design-hub -s user -- node "<путь>\src\server.js"
```

Lint и скриншоты запускают установленный Chrome или Edge в headless-режиме и управляют им по DevTools protocol (свой путь — `DESIGN_HUB_CHROME`). Без Chrome и Edge: `node cli/design-hub.js setup --browser` скачает headless Chromium.

## Как пользоваться

В Claude Code, в папке своего проекта:

- `/design-hub:design лендинг для чайной подписки` — полный цикл: выбор направления → 3 варианта на холсте → вы выбираете → сборка по шаблону → линт и критика → итерации;
- `/design-hub:canvas` — Claude слушает холст и выполняет то, что вы отправляете из браузера;
- `/design-hub:update` — проверить и подтянуть обновления OpenDesign, huashu и UI UX Pro Max;
- или просто: «сделай экран настроек», «проверь холст» — скилл `design` подхватится сам.

При установке без плагина вместо скиллов используются MCP-промпты `/mcp__design-hub__design` и `/mcp__design-hub__iterate`.

Проекты лежат в `<ваш проект>\.design-hub\<slug>\`: `project.json`, `DESIGN.md`, `nodes\n*.html`, `handoff\`. Каталог `.design-hub/` можно добавить в `.gitignore` или коммитить — как удобно.

### Холст

Адрес: `http://127.0.0.1:7777` (если порт занят, берётся следующий). Браузер открывается сам, когда:

- дизайн переходит в статус **Ready** (открывается выбранный фрейм);
- Claude показывает варианты на ревью (**In review**) или ждёт вашего фидбэка, а холст ещё не открыт.

| Действие | Как |
|---|---|
| Двигать холст | перетаскивание по фону, колесо мыши, пробел + перетаскивание |
| Масштаб | Ctrl/Cmd + колесо, `+` / `−`, Shift+1 — показать всё, Shift+2 — к выбранному |
| Выбрать фрейм | клик; двойной клик — **Interact** (кликать и скроллить внутри макета) |
| Правка элемента | **Select element** (или `E`) → клик по кнопке/блоку → описать → **Send to Claude** |
| Новая версия | выбрать фрейм → описать правку → **Send to Claude** (появится дочерний фрейм) |
| Варианты | `3 variations` — N соседних вариантов; без выбранного фрейма — N новых направлений |
| Остальное | mobile / tablet / desktop, Full height, Duplicate, Pin, Export ▾ → Open, Delete, перетаскивание за подпись |
| Режимы | **View** — только смотреть, **Edit** — менять холст |
| Инструменты | `V` — выбор, `H` — рука, `N` — заметка (клик по холсту), `E` — выбрать элемент |
| Мультивыбор | Shift+клик или рамка; группа двигается вместе, шаг сетки 24 px; **Auto layout** расставляет фреймы |
| Undo | Ctrl/Cmd+Z, повтор — Ctrl/Cmd+Shift+Z; Ctrl/Cmd+D — дубликат, Del — удалить |
| Связи | выбрать два фрейма → **Link**: стрелка потока с подписью; фильтр: все / навигация / скрыть |
| Заметки | стикеры; **Pin** делает заметку контекстом продукта, который Claude учитывает во всех следующих дизайнах |
| Тулбар фрейма | **Update ▾** (пресеты правок), **Create New ▾** (Variations, Next page in flow), Pin, **Export ▾** (Copy prompt, Copy HTML, Open) |
| Без MCP-петли | **Copy prompt** — готовый текст для вставки в Claude Code |

### Кто выполняет запросы из холста

Индикатор вверху справа показывает, кто возьмёт ваш запрос:

| Индикатор | Что происходит |
|---|---|
| **Claude is listening** | Ваша сессия Claude Code ждёт фидбэк (`canvas_wait_feedback` или `/mcp__design-hub__iterate`). Запрос уходит ей сразу. |
| **Claude Code on call** | Никто не слушает, поэтому через ~2 с хаб запускает фоновый `claude -p` в папке проекта (действуют ваши `CLAUDE.md` и логин). |
| **Claude Code is working** | Идёт фоновый запуск. Его шаги видны в **Activity**, там же кнопка **Stop**. |
| **Claude isn't listening** | Фоновые запуски выключены или CLI `claude` не найден. Запрос ждёт в очереди. |

Как устроен фоновый запуск:

- подключается к этому же серверу по MCP через HTTP (`/mcp` на localhost, с одноразовым токеном);
- работает только с инструментами design-hub и чтением файлов (`--strict-mcp-config`, `--allowedTools mcp__design-hub,Read,Glob,Grep`);
- отвечает в холсте на языке вашего запроса;
- если запуск ничего не сделал, запрос помечается как **Not done**, его можно повторить кнопкой **Retry**.

Фоновые запуски включаются и выключаются переключателем в **Activity** (или `DESIGN_HUB_RUNNER=off`). Модель задаёт `DESIGN_HUB_RUNNER_MODEL` (например, `sonnet` или `opus`), по умолчанию — модель из настроек Claude Code.

Панель **Activity** показывает:

- переписку: ваши запросы и ответы Claude со ссылками на новые фреймы;
- ход фонового запуска;
- отчёты критики и `DESIGN.md`.

### Без открытой сессии

`node cli/design-hub.js serve --open` поднимает только холст. Запросы из него выполняются фоновым Claude Code.

### Claude Desktop

- **Вкладка Code** — это тот же Claude Code: установленный плагин (или `claude mcp add`) подхватывается.
- **Обычный чат Desktop** — добавьте сервер в `%APPDATA%\Claude\claude_desktop_config.json` и укажите папку проектов явно, потому что у Desktop нет «текущего проекта»:

```json
{
  "mcpServers": {
    "design-hub": {
      "command": "node",
      "args": ["C:\\tools\\design-hub-mcp\\src\\server.js"],
      "env": { "DESIGN_HUB_WORKSPACE": "C:\\Users\\<вы>\\Projects\\my-app\\.design-hub" }
    }
  }
}
```

Фоновые запуски в любом случае используют CLI `claude`. Если он не в PATH, укажите путь в `DESIGN_HUB_CLAUDE`, например `%USERPROFILE%\.local\bin\claude.exe`.

## Обновление из родительских репозиториев

```powershell
node cli/design-hub.js check      # что изменилось: новые/удалённые системы, шаблоны, скиллы, правила
node cli/design-hub.js update     # подтянуть; установленные скиллы пересинхронизируются
node cli/design-hub.js rollback   # вернуть коммит, который был до последнего update
node cli/design-hub.js status
```

То же доступно из Claude через инструмент `hub_update` (`check` / `apply` / `rollback`).

Сервер раз в сутки проверяет обновления в фоне и сообщает о них в `hub_workflow` и `hub_status`. Применять их автоматически можно через `DESIGN_HUB_AUTO_UPDATE=1`.

- **Закрепить версию:** укажите `"ref"` (тег или коммит) у источника в `sources.json`.
- **Добавить источник:** новая запись в `sources.json` с картой `provides` (`systems` / `templates` / `skills` / `rules` / `references`). Для правки без изменения пакета скопируйте файл в `~/.design-hub/sources.json`. Пример — выключенный `anthropic-skills`.
- **Свои дизайн-системы, скиллы и правила:** кладите в `~/.design-hub/overrides/<kind>/`. Они имеют приоритет над одноимёнными из upstream, и обновление их не трогает.

### Скиллы как родные скиллы Claude Code

```powershell
node cli/design-hub.js skills install huashu-design open-design/anti-ai-slop
node cli/design-hub.js skills list
node cli/design-hub.js skills remove huashu-design
```

- Скилл ставится в `~/.claude/skills` (`--scope project` — в `.claude/skills` проекта).
- По умолчанию это ссылка (на Windows — junction), поэтому `update` подхватывается сразу. С `--mode copy` копия обновляется при `update`.
- Правила (`rules`) превращаются в сгенерированный скилл `design-rule-<name>`.
- Ставьте немного: каждый скилл занимает контекст. Через MCP (`catalog_get`) всё остальное доступно и без установки.
- UI UX Pro Max лучше использовать через `style_design_system` и `style_search`: его SKILL.md ссылается на пути плагина (`CLAUDE_PLUGIN_ROOT`), которых нет в `~/.claude/skills`.

## Инструменты MCP

| Группа | Инструменты |
|---|---|
| Хаб | `hub_workflow` (начинать с него), `hub_status`, `hub_update` |
| Каталог | `catalog_search`, `catalog_get` (шаблон приходит вместе со своими craft-правилами), `skills_install` |
| UI UX Pro Max | `style_design_system`, `style_search` (домены и стеки) |
| Проекты | `project_create`, `project_list`, `project_get`, `design_md_set` |
| Холст | `design_write`, `design_status`, `canvas_open`, `canvas_wait_feedback` (нет в фоновых запусках), `feedback_resolve`, `canvas_link` (стрелка между дизайнами), `canvas_note` (стикеры и закреплённый контекст) |
| Проверка | `design_screenshot` (картинки в ответ), `design_lint` (рендер + anti-slop), `critique_save` (отчёт с радаром) |
| В код | `handoff` (HTML + DESIGN.md + токены + HANDOFF.md с правилами стека) |

`design_write` принимает `link_from` / `link_label` (следующая страница потока), `project_get` отдаёт `edges`, `notes` и `context`.

### Как источники разведены между собой

`hub_workflow` фиксирует, кто за что отвечает, чтобы инструменты не спорили:

- `DESIGN.md` — единственный источник токенов;
- выбор направления — один раз: UI UX Pro Max сужает до трёх вариантов, на холсте рисуются 3 корня, вы выбираете;
- если бренд уже задан, три варианта делаются внутри системы;
- критика одна (5 измерений) и отдельным шагом, по скриншоту и линту;
- P0 из линта исправляются до Ready.

## Переменные окружения

| Переменная | По умолчанию | |
|---|---|---|
| `DESIGN_HUB_PORT` | `7777` | порт превью |
| `DESIGN_HUB_OPEN` | `ready` | `ready` / `always` / `never` — когда открывать браузер |
| `DESIGN_HUB_WORKSPACE` | `<cwd>\.design-hub` | где хранить проекты |
| `DESIGN_HUB_HOME` | `~\.design-hub` | источники, overrides, состояние |
| `DESIGN_HUB_UPDATE_CHECK_DAYS` | `1` | частота фоновой проверки (0 — выключить) |
| `DESIGN_HUB_AUTO_UPDATE` | — | `1` — применять обновления автоматически |
| `DESIGN_HUB_PYTHON` | авто (`py -3` / `python` / `python3`) | |
| `DESIGN_HUB_CHROME` | авто (Chromium → Chrome → Edge) | путь к браузеру для линта и скриншотов |
| `DESIGN_HUB_RUNNER` | `on` | `off` — не запускать фоновый Claude Code (переключатель в UI сильнее) |
| `DESIGN_HUB_RUNNER_MODEL` | модель Claude Code по умолчанию | например, `sonnet` или `opus` |
| `DESIGN_HUB_RUNNER_MAX_TURNS` | `60` | лимит шагов фонового запуска |
| `DESIGN_HUB_RUNNER_TIMEOUT_MIN` | `20` | после этого запуск останавливается |
| `DESIGN_HUB_CLAUDE` | авто (`where`/`which claude`) | путь к CLI Claude Code |

Передать переменные при регистрации: `claude mcp add design-hub -s user -e DESIGN_HUB_OPEN=always -- node "...\src\server.js"`.

## Ограничения

- Макеты — самодостаточные HTML-страницы, а не Figma-слои. В код их переносит `handoff`.
- Iframe холста изолирован (`sandbox` без same-origin). Если макет использует `localStorage`, в превью это может не работать, а в открытом отдельно файле работает.
- Рендерные проверки нужны Chrome, Edge или `setup --browser`. Без них `design_lint` делает только статические проверки.
- Качество по-прежнему задаёт модель: на слабой модели связка не спасёт.
- Фоновые запуски расходуют лимиты вашей подписки так же, как обычная работа в Claude Code. Один запрос — это один запуск: обычно 30–90 секунд, запросы, пришедшие за это время, идут следующим запуском.

## Лицензии

Код Design Hub — MIT. Источники клонируются с их лицензиями и не входят в пакет: OpenDesign — Apache-2.0 (часть шаблонов MIT), huashu-design — MIT, UI UX Pro Max — MIT.
