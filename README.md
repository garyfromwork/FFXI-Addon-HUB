# FFXI Addon HUB

A community-built addon manager for **Final Fantasy XI Windower** — browse, install, and update Windower addons from a polished desktop app, similar to CurseForge or Nexus Mods.

Built with **Electron** and **Supabase**.

---

## Download

Go to the [**Releases**](../../releases/latest) page and grab the file for your platform:

| Platform | File |
|---|---|
| Windows | `FFXI-Addon-HUB-Setup-x.x.x.exe` |
| Linux | `FFXI-Addon-HUB-x.x.x.AppImage` |

**Windows:** Run the installer — it creates a Start Menu shortcut and desktop icon.

**Linux:** Make the AppImage executable and run it: `chmod +x FFXI-Addon-HUB-*.AppImage && ./FFXI-Addon-HUB-*.AppImage`
If you run FFXI through Wine, point the Windower path to your Wine prefix location (e.g. `~/.wine/drive_c/Windower`).

The app checks for updates automatically on every launch.

> **No account or setup required to browse.** Sign up for a free account inside the app to install addons, leave reviews, and message other users.

---

## Features

- **Browse & Search** — Browse all community addons with live search and sorting (A–Z, by author, etc.)
- **One-click Install / Update / Uninstall** — Addons are downloaded and extracted directly into your Windower directory
- **My Library** — See only the addons you have installed
- **Star Ratings & Reviews** — Rate and review any addon; see community scores on every card
- **User Profiles** — Avatar upload, bio, and private notes that sync across devices
- **Direct Messaging** — Send DMs to other users directly from the app
- **Submit Addons** — Any logged-in user can submit a new addon via a form with GitHub auto-fill
- **Auto-updates** — The app updates itself silently in the background
- **Keyboard shortcuts** — `Ctrl+1` Browse · `Ctrl+2` Library · `Ctrl+3` Profile · `Ctrl+4` Messages

---

## Getting Started

### 1 — Set your Windower path

Go to **⚙ Settings** and click **Browse for Folder** to select your Windower 4 installation directory — the folder that contains the `addons` subfolder (e.g. `C:\Windower`).

### 2 — Browse and install

Use the **Browse** view to search, sort, and install addons. Click any card to see the full description, star rating, and community reviews, then hit **Install**.

### 3 — Create an account (optional)

Click **Sign In** in the sidebar to register a free account. An account lets you:
- Install and track addons
- Leave ratings and reviews
- Set up a profile with an avatar and bio
- Send direct messages to other users
- Submit new addons to the community

---

## Feature Guide

### Installing Addons

- Search by name, author, or keyword
- Sort by Default, Name A–Z, Name Z–A, or By Author
- Click **Install** on any card, or open the detail panel for the full description and reviews first
- Click **Uninstall** from the detail panel to remove an addon (a confirmation prompt appears)

### Reviews & Ratings

- Open any addon's detail panel and switch to the **Reviews** tab
- Pick a star rating, write an optional review, and click **Submit Review**
- Average ratings are shown on every card in the grid

### Profile

- Go to **◎ Profile** to set your display name, upload an avatar, and write a bio
- **Private Notes** are only visible to you — useful for tracking addon configs or keybinds
- Your profile is visible to other users when they view your reviews

### Direct Messages

- Click **✉ Messages** in the sidebar
- Click **+ New** to find a user by username and start a conversation
- Press **Enter** to send, **Shift+Enter** for a new line
- An unread badge on the Messages nav item updates in the background
- Click **✉ DM** on any review card to message that reviewer directly

### Submitting Addons

1. Click **+ Submit Addon** in the Browse header (requires sign-in)
2. Paste a GitHub repo URL — name, author, description, and download URL are auto-filled via the GitHub API
3. Confirm the **Folder Name** matches what Windower expects (usually the repo name)
4. Click **Submit Addon** — it appears in Browse immediately

---

## For Developers / Contributors

> **This section is only for developers who want to run the code locally or contribute.** Regular users just download the installer from the Releases page — there is nothing to configure.

### Prerequisites

- [Node.js](https://nodejs.org/) 18+

### Local Setup

```bash
git clone https://github.com/Garyfromwork/FFXI-Addon-HUB.git
cd FFXI-Addon-HUB
npm install
```

Create a `config.js` in the project root (this file is gitignored):

```js
module.exports = {
  supabaseUrl: 'https://your-project.supabase.co',
  supabaseKey: 'your-anon-key',
};
```

Contact the project owner for the config values if you are contributing to the official instance.

```bash
npm start
```

### Building an Installer

```bash
npm run build
```

The installer is created in the `dist/` folder.

### Publishing a Release

Requires a GitHub Classic Personal Access Token (`repo` scope) set as `GH_TOKEN`:

```powershell
$env:GH_TOKEN="ghp_yourtoken"
npm run release
```

Bump `version` in `package.json` before each release. Users already running the app will be notified automatically.

---

## Self-Hosting

If you want to fork this project and run your own independent community hub, you will need your own Supabase project. Run the SQL below in the Supabase SQL Editor, then create `config.js` with your own credentials and build the installer.

<details>
<summary>Database setup SQL</summary>

```sql
-- Addons
create table public.addons (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  author text,
  description text,
  folder_name text not null,
  download_url text not null,
  created_at timestamptz default now()
);
alter table public.addons enable row level security;
create policy "Anyone can view addons" on public.addons for select using (true);
create policy "Authenticated users can submit addons" on public.addons for insert to authenticated with check (true);

-- Profiles
create table public.profiles (
  id uuid references auth.users primary key,
  username text,
  avatar_url text,
  bio text,
  notes text
);
alter table public.profiles enable row level security;
create policy "Profiles are public" on public.profiles for select using (true);
create policy "Users can insert own profile" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update to authenticated using (auth.uid() = id);

-- Reviews
create table public.reviews (
  id uuid default gen_random_uuid() primary key,
  addon_id uuid references public.addons on delete cascade,
  user_id uuid references auth.users,
  rating int check (rating between 1 and 5),
  review_text text,
  created_at timestamptz default now()
);
alter table public.reviews enable row level security;
create policy "Anyone can view reviews" on public.reviews for select using (true);
create policy "Authenticated users can submit reviews" on public.reviews for insert to authenticated with check (auth.uid() = user_id);

-- Messages
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  sender_id uuid references public.profiles(id) on delete cascade not null,
  receiver_id uuid references public.profiles(id) on delete cascade not null,
  content text not null check (char_length(content) > 0),
  read boolean default false not null,
  created_at timestamptz default now() not null
);
alter table public.messages enable row level security;
create policy "Users can read their own messages" on public.messages for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "Users can send messages" on public.messages for insert to authenticated
  with check (auth.uid() = sender_id);
create policy "Receivers can mark messages read" on public.messages for update to authenticated
  using (auth.uid() = receiver_id);
```

Create an `avatars` storage bucket set to **Public**, then:

```sql
create policy "Users can upload own avatar" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users can update own avatar" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Anyone can view avatars" on storage.objects for select to public
  using (bucket_id = 'avatars');
```

</details>

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 42 |
| Backend / Auth / DB | Supabase |
| Storage | Supabase Storage |
| Auto-updates | electron-updater + GitHub Releases |
| Packaging | electron-builder |
| Frontend | Vanilla HTML / CSS / JS |

---

## License

ISC © 2026 Garyfromwork
