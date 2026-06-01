# FFXI Addon HUB

A community-built addon manager for **Final Fantasy XI Windower** — browse, install, and update Windower addons from a polished desktop app, similar to CurseForge or Nexus Mods.

Built with **Electron** and **Supabase**.

---

## Features

- **Browse & Search** — Browse all community addons with live search and sorting (A–Z, by author, etc.)
- **One-click Install / Update / Uninstall** — Addons are downloaded and extracted directly into your Windower directory
- **My Library** — See only the addons you have installed
- **Star Ratings & Reviews** — Rate and review any addon; see community scores on every card
- **User Profiles** — Avatar upload, bio, and private notes that sync across devices
- **Direct Messaging** — Send DMs to other users directly from the app
- **Submit Addons** — Any logged-in user can submit a new addon via a form with GitHub auto-fill
- **Import from GitHub** — Bulk-import all repos tagged `windower-addon` on GitHub with one click
- **Auto-updates** — The app updates itself silently in the background using GitHub Releases
- **Keyboard shortcuts** — `Ctrl+1` Browse · `Ctrl+2` Library · `Ctrl+3` Profile · `Ctrl+4` Messages

---

## Download & Install

Go to the [**Releases**](../../releases/latest) page and download the latest `FFXI-Addon-HUB-Setup-x.x.x.exe`.

Run the installer — it will create a Start Menu shortcut and desktop icon. The app checks for updates automatically on launch.

---

## Getting Started (End Users)

1. **Sign Up / Sign In** — Click *Sign In* in the sidebar to create a free account
2. **Set your Windower path** — Go to ⚙ Settings and click *Browse for Folder* to select your Windower 4 installation directory (the folder that contains the `addons` subfolder)
3. **Browse addons** — Use the Browse view to search, sort, and install addons
4. **View your library** — Switch to *My Library* to see everything currently installed

---

## Feature Guide

### Browsing & Installing

- Search by name, author, or keyword
- Sort by Default, Name A–Z, Name Z–A, or By Author
- Click any card to open the addon detail panel with full description, star ratings, and all reviews
- Click **Install** to download and extract to your Windower `addons` folder
- Click **Uninstall** from the detail panel to remove it (a confirmation dialog will appear)

### Reviews & Ratings

- Open any addon's detail panel and switch to the **Reviews** tab
- Select a star rating and write an optional review, then click **Submit Review**
- Average ratings appear on every addon card in the grid

### Profile

- Go to ◎ Profile to set your display name, avatar, and bio
- Click your avatar (or the *Choose File* button) to upload a profile picture
- **Private Notes** are visible only to you — useful for tracking addon configs or keybinds
- Your profile is visible to other users when they read your reviews

### Direct Messages

- Click ✉ Messages in the sidebar to open your inbox
- Click **+ New** to search for a user by username and start a conversation
- Press **Enter** to send · **Shift+Enter** for a new line
- Unread message count appears as a badge on the Messages nav item
- You can also click **✉ DM** on any review card to message that reviewer directly

### Submitting Addons

Any logged-in user can submit an addon:

1. Click **+ Submit Addon** in the Browse header
2. Paste a GitHub repo URL — the form auto-fills name, author, description, and download URL using the GitHub API
3. Verify the **Folder Name** matches what Windower expects (usually the repo name)
4. Click **Submit Addon**

### Importing from GitHub (Admin)

The Settings view has an **Import from GitHub** tool that:

- Fetches all repositories tagged `windower-addon` on GitHub (the same source as windower-addons.com)
- Compares against your existing database and marks already-imported addons
- Lets you select/deselect and bulk-import in one operation

---

## For Developers

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Supabase](https://supabase.com) project (free tier works)

### Setup

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

Then start the app:

```bash
npm start
```

### Building an Installer

```bash
npm run build
```

The installer is created in the `dist/` folder.

### Publishing a Release

Requires a GitHub Classic Personal Access Token with the `repo` scope set as `GH_TOKEN`:

```powershell
$env:GH_TOKEN="ghp_yourtoken"
npm run release
```

This builds the installer, creates a GitHub Release, and uploads all files including the `latest.yml` update manifest. Users already running the app will be notified of the update on next launch.

---

## Supabase Setup

### Database Tables

Run the following in your Supabase SQL Editor:

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
create policy "Users can read their own messages" on public.messages for select to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "Users can send messages" on public.messages for insert to authenticated with check (auth.uid() = sender_id);
create policy "Receivers can mark messages read" on public.messages for update to authenticated using (auth.uid() = receiver_id);
```

### Storage (for Avatar Uploads)

1. In Supabase dashboard go to **Storage** and create a bucket named `avatars` — set it to **Public**
2. Add these policies in the SQL Editor:

```sql
create policy "Authenticated users can upload their own avatar"
on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Authenticated users can update their own avatar"
on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Anyone can view avatars"
on storage.objects for select to public
using (bucket_id = 'avatars');
```

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
