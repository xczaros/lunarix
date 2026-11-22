<p align="center">
  <img src="assets/icon-256.png" width="96" alt="Lunarix">
</p>

<h1 align="center">Lunarix</h1>

<p align="center">
  Darmowy agent AI do programowania na Windowsa. Piszesz, co chcesz zbudować, a on planuje, koduje, odpala i poprawia.
</p>

<p align="center">
  <a href="https://github.com/xczaros/lunarix/releases/latest"><b>Pobierz najnowszą wersję</b></a>
</p>

---

## Co to jest

Lunarix to aplikacja w stylu Cursora czy Claude Code, tyle że darmowa i bez limitów. Możesz pracować na modelach lokalnych, które działają na Twojej karcie graficznej, albo podpiąć własne klucze API.

Agent ma dostęp do komputera, więc robi to, co zrobiłby programista:

- tworzy i edytuje pliki w projekcie,
- odpala komendy w terminalu i doinstalowuje potrzebne narzędzia,
- otwiera stronę w przeglądarce i robi zrzuty ekranu, żeby sprawdzić efekt,
- czyta załączniki (ZIP, PDF, obrazki) i zrzuty ekranu wklejone do czatu,
- prowadzi plan zadań i odhacza kolejne kroki.

## Modele

**Lokalne** (llama.cpp, wszystko zostaje na Twoim komputerze):

| Poziom | Model | Dla kogo |
| --- | --- | --- |
| Low | Qwen3.5 2B | słabsze laptopy, sam procesor |
| Medium | Qwen3.5 4B | karta z 4–6 GB VRAM |
| High | Qwen3.5 9B | karta z 8 GB+ |
| Extra | Qwen3.6 35B-A3B | mocny PC, dużo RAM |
| Max | Qwen3.8 27B | karta z 24 GB+ |

Przy pierwszym uruchomieniu Lunarix sprawdza sprzęt i sam proponuje model. Potem mierzy realną prędkość i podpowiada zmianę, jeśli coś działa za wolno.

**W chmurze** (własny klucz): Anthropic, OpenAI, Google Gemini, xAI Grok, Groq, OpenRouter, Cloudflare Workers AI. Działa też Ollama, LM Studio i każde API zgodne z OpenAI. Lista modeli pobiera się automatycznie, a zużycie tokenów widać na bieżąco.

## Instalacja

1. Pobierz `lunarix-setup.exe` z [Releases](https://github.com/xczaros/lunarix/releases/latest).
2. Uruchom i kliknij „Zainstaluj”. Nie trzeba uprawnień administratora.
3. Przejdź krótki start: wybierz model albo wklej klucz API.

Wymagania: Windows 10 lub 11 (64-bit). Do modeli lokalnych przyda się karta NVIDIA, ale Low i Medium dadzą radę także bez niej.

Aktualizacje są obowiązkowe. Kiedy wychodzi nowa wersja, aplikacja sama ją pobiera i instaluje, a czaty, projekty i klucze zostają.

## Budowanie ze źródeł

Potrzebujesz Node.js 22+ i (do instalatora) .NET SDK.

```powershell
npm install
npm run build
npm start
```

Instalator `dist/lunarix-setup.exe`:

```powershell
npm run dist
```

## Struktura

```
src/main       proces główny Electrona: agent, narzędzia, providerzy, silnik lokalny, aktualizacje
src/renderer   interfejs (React)
src/preload    most między interfejsem a procesem głównym
src/shared     typy i katalog modeli
installer      własny instalator (C# / WPF)
scripts        build, pakowanie i testy
```

## Licencja

MIT
