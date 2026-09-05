# Кликер

## Локальный запуск

Нужен Python 3.11+.

```powershell
py -3 -m venv C:\\Users\\$env:USERNAME\\clicker-venv
C:\\Users\\$env:USERNAME\\clicker-venv\\Scripts\\python.exe -m pip install -r requirements.txt
$env:CLICKER_SECRET_KEY = "вставьте-длинную-случайную-строку"
C:\\Users\\$env:USERNAME\\clicker-venv\\Scripts\\python.exe app.py
```

Откройте `http://127.0.0.1:5050`.

## Проверки

```powershell
C:\\Users\\$env:USERNAME\\clicker-venv\\Scripts\\python.exe -m unittest discover -s tests -v
```

Тесты используют временную базу и не изменяют рабочую `clicker.db`.

## Выгрузка на VPS

Production-конфигурация рассчитана на Ubuntu и домен `max-click-pesh.iteacher-alex.org`.
На сервере создаётся один изолированный каталог `/var/www/clicker`:

- `app` — Git-клон приложения;
- `venv` — отдельное Python-окружение проекта;
- `data/clicker.db` — постоянная база, не входящая в Git и не меняющаяся при обновлениях;
- `.ssh/id_ed25519_github` — отдельный deploy key этого проекта для GitHub.

Перед первым запуском в Cloudflare у записи `A` для домена должен быть IP `65.20.72.135`. Для выпуска Let's Encrypt сертификата временно отключите проксирование (DNS only), либо убедитесь, что Cloudflare пропускает HTTP-проверку. После выпуска включите проксирование обратно и установите режим SSL/TLS **Full (strict)**.

Подключитесь к VPS под пользователем с `sudo`, скопируйте на него `deploy/bootstrap-vps.sh` и выполните:

```bash
sudo bash bootstrap-vps.sh
```

Команда напечатает публичный ключ. Добавьте его в GitHub в репозитории `MaxPeshCryp/cliker_v2`: **Settings → Deploy keys → Add deploy key**. Доступ на запись ключу не нужен. Затем на VPS:

```bash
sudo -u clicker git clone git@github.com:MaxPeshCryp/cliker_v2.git /var/www/clicker/app
sudo cp /var/www/clicker/app/.env.example /var/www/clicker/.env
sudo nano /var/www/clicker/.env
sudo openssl rand -hex 48
```

В `.env` вставьте сгенерированное значение вместо `replace-with-a-long-random-secret` и свой адрес вместо `replace-with-your-email@example.com`.

### Одноразовый перенос текущей базы

Когда директория проекта уже создана на VPS, но **до** первого запуска сайта, из PowerShell на компьютере выполните:

```powershell
.\\deploy\\push-initial-db.ps1 -SshUser root -IdentityFile C:\\path\\to\\your\\vps-key
```

Скрипт сначала убеждается, что `/var/www/clicker/data/clicker.db` отсутствует. Если база уже есть, он завершится ошибкой и ничего не перезапишет. Это защищает игровые данные при последующих релизах.

После успешного переноса базы завершите первый запуск на VPS:

```bash
sudo bash /var/www/clicker/app/deploy/update-vps.sh
```

### Следующие обновления

Базу больше не копируйте. На VPS после `git push` достаточно выполнить:

```bash
sudo bash /var/www/clicker/app/deploy/update-vps.sh
```
