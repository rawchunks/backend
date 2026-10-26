import { userSql, songSql } from './client.js';

export async function runMigrations() {
  console.log('--- Initializing Neon Databases ---');

  // 1. User Database Migrations
  console.log('Migrating User Database...');
  await userSql`
    CREATE TABLE IF NOT EXISTS public.wallet_pairs (
      evm_address TEXT UNIQUE,
      svm_address TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      consented_at TIMESTAMPTZ,
      consent_version TEXT,
      consent_signature TEXT,
      consent_message TEXT,
      consent_metadata JSONB,
      nickname TEXT,
      avatar TEXT,
      bio TEXT,
      guides_seen JSONB DEFAULT '[]'::jsonb NOT NULL
    );
  `;
  await userSql`DROP TABLE IF EXISTS public.users;`;
  await userSql`ALTER TABLE public.wallet_pairs ADD COLUMN IF NOT EXISTS nickname TEXT, ADD COLUMN IF NOT EXISTS avatar TEXT, ADD COLUMN IF NOT EXISTS bio TEXT, ADD COLUMN IF NOT EXISTS guides_seen JSONB DEFAULT '[]'::jsonb NOT NULL;`;
  await userSql`UPDATE public.wallet_pairs SET svm_address = NULL WHERE svm_address LIKE 'svm_pending_%';`;
  await userSql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wallet_pairs_pkey' AND conrelid = 'public.wallet_pairs'::regclass
      ) THEN
        ALTER TABLE public.wallet_pairs DROP CONSTRAINT wallet_pairs_pkey;
      END IF;
      ALTER TABLE public.wallet_pairs ALTER COLUMN evm_address DROP NOT NULL;
      ALTER TABLE public.wallet_pairs ALTER COLUMN svm_address DROP NOT NULL;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wallet_pairs_evm_address_key' AND conrelid = 'public.wallet_pairs'::regclass
      ) THEN
        ALTER TABLE public.wallet_pairs ADD CONSTRAINT wallet_pairs_evm_address_key UNIQUE (evm_address);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wallet_pairs_svm_address_key' AND conrelid = 'public.wallet_pairs'::regclass
      ) THEN
        ALTER TABLE public.wallet_pairs ADD CONSTRAINT wallet_pairs_svm_address_key UNIQUE (svm_address);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'wallet_pairs_address_present_check' AND conrelid = 'public.wallet_pairs'::regclass
      ) THEN
        ALTER TABLE public.wallet_pairs ADD CONSTRAINT wallet_pairs_address_present_check CHECK (evm_address IS NOT NULL OR svm_address IS NOT NULL);
      END IF;
    END $$;
  `;
  console.log('✓ User database schema verified (wallet_pairs).');

  // 2. Song Database Migrations
  console.log('Migrating Song Database (songs, stems, takes, commits)...');
  await songSql`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      version INTEGER DEFAULT 1 NOT NULL,
      family TEXT,
      basis TEXT,
      source TEXT,
      creator TEXT NOT NULL,
      url TEXT NOT NULL,
      licenses INTEGER DEFAULT 0 NOT NULL,
      stream_price REAL DEFAULT 0.02 NOT NULL,
      license_price REAL DEFAULT 25.0 NOT NULL,
      duration REAL,
      tags JSONB DEFAULT '[]'::jsonb NOT NULL,
      metadata_cid TEXT,
      public BOOLEAN DEFAULT FALSE NOT NULL,
      network TEXT,
      chain_song_id TEXT,
      tx_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;
  await songSql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS metadata_cid TEXT;`;
  await songSql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS public BOOLEAN DEFAULT FALSE NOT NULL, ADD COLUMN IF NOT EXISTS network TEXT, ADD COLUMN IF NOT EXISTS chain_song_id TEXT, ADD COLUMN IF NOT EXISTS tx_hash TEXT;`;
  await songSql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS family TEXT, ADD COLUMN IF NOT EXISTS basis TEXT;`;

  await songSql`
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      creator TEXT NOT NULL,
      description TEXT,
      cover TEXT,
      public BOOLEAN DEFAULT FALSE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;
  await songSql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS image TEXT;`;
  await songSql`UPDATE songs SET image = '' WHERE image = '/hero.png';`;
  await songSql`ALTER TABLE songs ADD COLUMN IF NOT EXISTS album_id TEXT REFERENCES albums(id) ON DELETE SET NULL;`;

  await songSql`
    CREATE TABLE IF NOT EXISTS stems (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      waveform_peaks_url TEXT,
      volume REAL DEFAULT 1.0 NOT NULL,
      pan REAL DEFAULT 0.0 NOT NULL,
      is_muted BOOLEAN DEFAULT FALSE NOT NULL,
      is_solo BOOLEAN DEFAULT FALSE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;

  await songSql`
    CREATE TABLE IF NOT EXISTS takes (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      stem_id TEXT REFERENCES stems(id) ON DELETE SET NULL,
      take_number INTEGER DEFAULT 1 NOT NULL,
      model TEXT NOT NULL,
      task TEXT NOT NULL,
      prompt TEXT,
      lyrics TEXT,
      repainting_start REAL,
      repainting_end REAL,
      url TEXT NOT NULL,
      waveform_url TEXT,
      is_active BOOLEAN DEFAULT FALSE NOT NULL,
      seed BIGINT,
      provenance JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;
  await songSql`ALTER TABLE takes ADD COLUMN IF NOT EXISTS provenance JSONB;`;

  await songSql`
    CREATE TABLE IF NOT EXISTS commits (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      user_address TEXT NOT NULL,
      parent_commit_id TEXT,
      message TEXT NOT NULL,
      timeline_snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;

  await songSql`
    CREATE TABLE IF NOT EXISTS voices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT NOT NULL,
      sample_url TEXT,
      hash TEXT,
      source_song_id TEXT,
      canonical_id TEXT,
      task_id TEXT,
      metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
      training_group TEXT NOT NULL,
      error TEXT,
      status TEXT DEFAULT 'saved' NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    );
  `;
  // Repair older installations as well as new CREATE TABLE definitions.
  await songSql`ALTER TABLE songs ALTER COLUMN duration DROP NOT NULL, ALTER COLUMN duration DROP DEFAULT;`;
  await songSql`ALTER TABLE voices ADD COLUMN IF NOT EXISTS sample_url TEXT, ADD COLUMN IF NOT EXISTS hash TEXT, ADD COLUMN IF NOT EXISTS source_song_id TEXT, ADD COLUMN IF NOT EXISTS canonical_id TEXT, ADD COLUMN IF NOT EXISTS task_id TEXT, ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb NOT NULL, ADD COLUMN IF NOT EXISTS training_group TEXT, ADD COLUMN IF NOT EXISTS error TEXT;`;
  await songSql`
    DO $$ BEGIN
      -- A legacy weights URL has no checkpoint or settings identity. Preserve it
      -- for explicit inventory repair; never silently drop a nonempty value.
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'voices' AND column_name = 'url') THEN
        IF EXISTS (SELECT 1 FROM voices WHERE nullif(trim(url), '') IS NOT NULL) THEN
          RAISE EXCEPTION 'Legacy voice adapter URLs require explicit inventory migration before removing voices.url';
        END IF;
        ALTER TABLE voices DROP COLUMN url;
      END IF;
      ALTER TABLE voices DROP CONSTRAINT IF EXISTS voices_status_check;
      UPDATE voices SET training_group = 'vg-' || id WHERE training_group IS NULL;
      ALTER TABLE voices ALTER COLUMN training_group SET NOT NULL;
      ALTER TABLE voices ALTER COLUMN status SET DEFAULT 'saved';
      ALTER TABLE voices ADD CONSTRAINT voices_status_check CHECK (status IN ('saved', 'extracting', 'queued', 'training', 'ready', 'error'));
    END $$;
  `;
  await songSql`
    CREATE TABLE IF NOT EXISTS voice_adapters (
      id TEXT PRIMARY KEY,
      training_group TEXT NOT NULL,
      model TEXT NOT NULL,
      checkpoint_fingerprint TEXT NOT NULL,
      settings JSONB NOT NULL,
      settings_digest TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'queued' NOT NULL,
      artifact_url TEXT,
      artifact_digest TEXT,
      metrics JSONB DEFAULT '{}'::jsonb NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      CONSTRAINT voice_adapters_status_check CHECK (status IN ('queued', 'training', 'ready', 'error')),
      CONSTRAINT voice_adapters_digest_check CHECK (settings_digest ~ '^[a-f0-9]{64}$' AND (artifact_digest IS NULL OR artifact_digest ~ '^[a-f0-9]{64}$')),
      CONSTRAINT voice_adapters_ready_check CHECK (status <> 'ready' OR (nullif(trim(artifact_url), '') IS NOT NULL AND artifact_digest IS NOT NULL))
    );
  `;
  await songSql`
    UPDATE voices voice SET status = CASE WHEN nullif(trim(voice.sample_url), '') IS NOT NULL THEN 'saved' ELSE 'error' END,
      error = CASE WHEN nullif(trim(voice.sample_url), '') IS NULL THEN coalesce(voice.error, 'Legacy voice has no saved sample') ELSE NULL END
    WHERE voice.status = 'ready' AND (
      NOT EXISTS (SELECT 1 FROM voice_adapters a WHERE a.training_group = voice.training_group AND a.model = 'acestep-v15-xl-turbo' AND a.status = 'ready' AND nullif(trim(a.artifact_url), '') IS NOT NULL AND a.artifact_digest ~ '^[a-f0-9]{64}$')
      OR NOT EXISTS (SELECT 1 FROM voice_adapters a WHERE a.training_group = voice.training_group AND a.model = 'acestep-v15-xl-sft' AND a.status = 'ready' AND nullif(trim(a.artifact_url), '') IS NOT NULL AND a.artifact_digest ~ '^[a-f0-9]{64}$')
    );
  `;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS voice_adapters_identity_idx ON voice_adapters (training_group, model, checkpoint_fingerprint, settings_digest);`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS voice_adapters_task_idx ON voice_adapters (task_id);`;
  await songSql`CREATE INDEX IF NOT EXISTS voice_adapters_group_idx ON voice_adapters (training_group);`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS voices_owner_hash_idx ON voices (creator, hash) WHERE canonical_id IS NULL AND hash IS NOT NULL;`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS voices_id_creator_idx ON voices (id, creator);`;
  await songSql`CREATE INDEX IF NOT EXISTS voices_pending_idx ON voices (status) WHERE canonical_id IS NULL AND status NOT IN ('ready', 'error');`;
  await songSql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voices_canonical_owner_fk' AND conrelid = 'voices'::regclass) THEN
        ALTER TABLE voices ADD CONSTRAINT voices_canonical_owner_fk FOREIGN KEY (canonical_id, creator) REFERENCES voices (id, creator);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voices_hash_check' AND conrelid = 'voices'::regclass) THEN
        ALTER TABLE voices ADD CONSTRAINT voices_hash_check CHECK (hash IS NULL OR hash ~ '^[a-f0-9]{64}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voices_alias_check' AND conrelid = 'voices'::regclass) THEN
        ALTER TABLE voices ADD CONSTRAINT voices_alias_check CHECK (canonical_id IS NULL OR canonical_id <> id);
      END IF;
    END $$;
  `;
  await songSql`CREATE INDEX IF NOT EXISTS songs_creator_created_idx ON songs (creator, created_at DESC);`;
  await songSql`CREATE INDEX IF NOT EXISTS songs_created_idx ON songs (created_at DESC);`;
  await songSql`CREATE INDEX IF NOT EXISTS songs_public_created_idx ON songs (created_at DESC) WHERE public = true;`;
  await songSql`CREATE INDEX IF NOT EXISTS songs_family_idx ON songs (family, version);`;
  await songSql`CREATE INDEX IF NOT EXISTS songs_basis_idx ON songs (basis);`;
  await songSql`CREATE INDEX IF NOT EXISTS voices_creator_created_idx ON voices (creator, created_at DESC);`;
  await songSql`CREATE INDEX IF NOT EXISTS stems_song_idx ON stems (song_id);`;
  await songSql`CREATE INDEX IF NOT EXISTS takes_song_stem_idx ON takes (song_id, stem_id);`;
  await songSql`CREATE INDEX IF NOT EXISTS commits_song_created_idx ON commits (song_id, created_at DESC);`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS stems_song_id_id_unique ON stems (song_id, id);`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS commits_song_id_id_unique ON commits (song_id, id);`;
  await songSql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM takes t JOIN songs song ON song.id = t.song_id
        LEFT JOIN stems stem ON stem.id = t.stem_id AND stem.song_id = t.song_id
        WHERE t.is_active GROUP BY t.song_id, t.stem_id
        HAVING count(*) > 1 AND count(*) FILTER (WHERE t.url = coalesce(stem.url, song.url)) <> 1
      ) THEN
        RAISE EXCEPTION 'Multiple active takes have no unique match to the current lane audio';
      END IF;
      UPDATE takes t SET is_active = false
      FROM (
        SELECT active.song_id, active.stem_id, coalesce(stem.url, song.url) AS current_url
        FROM takes active JOIN songs song ON song.id = active.song_id
        LEFT JOIN stems stem ON stem.id = active.stem_id AND stem.song_id = active.song_id
        WHERE active.is_active
        GROUP BY active.song_id, active.stem_id, stem.url, song.url HAVING count(*) > 1
      ) current
      WHERE t.song_id = current.song_id AND t.stem_id IS NOT DISTINCT FROM current.stem_id
        AND t.is_active AND t.url <> current.current_url;
    END $$;
  `;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS takes_active_stem_idx ON takes (song_id, stem_id) WHERE is_active AND stem_id IS NOT NULL;`;
  await songSql`CREATE UNIQUE INDEX IF NOT EXISTS takes_active_master_idx ON takes (song_id) WHERE is_active AND stem_id IS NULL;`;
  await songSql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'takes_song_stem_fk' AND conrelid = 'takes'::regclass) THEN
        ALTER TABLE takes ADD CONSTRAINT takes_song_stem_fk FOREIGN KEY (song_id, stem_id) REFERENCES stems (song_id, id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commits_song_parent_fk' AND conrelid = 'commits'::regclass) THEN
        ALTER TABLE commits ADD CONSTRAINT commits_song_parent_fk FOREIGN KEY (song_id, parent_commit_id) REFERENCES commits (song_id, id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'songs_values_check' AND conrelid = 'songs'::regclass) THEN
        ALTER TABLE songs ADD CONSTRAINT songs_values_check CHECK (version > 0 AND licenses >= 0 AND stream_price >= 0 AND stream_price < 'Infinity'::real AND license_price >= 0 AND license_price < 'Infinity'::real AND (duration IS NULL OR (duration >= 0 AND duration < 'Infinity'::real)));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stems_mixer_check' AND conrelid = 'stems'::regclass) THEN
        ALTER TABLE stems ADD CONSTRAINT stems_mixer_check CHECK (volume >= 0 AND volume < 'Infinity'::real AND pan BETWEEN -1 AND 1);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'takes_values_check' AND conrelid = 'takes'::regclass) THEN
        ALTER TABLE takes ADD CONSTRAINT takes_values_check CHECK (take_number > 0 AND (repainting_start IS NULL OR (repainting_start >= 0 AND repainting_start < 'Infinity'::real)) AND (repainting_end IS NULL OR (repainting_end >= 0 AND repainting_end < 'Infinity'::real)) AND (repainting_start IS NULL OR repainting_end IS NULL OR repainting_end >= repainting_start));
      END IF;
    END $$;
  `;
  console.log('✓ Song database schema verified (songs, stems, takes, commits, voices).');
  console.log('--- All Neon Databases successfully migrated ---');
}

// If invoked directly via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
