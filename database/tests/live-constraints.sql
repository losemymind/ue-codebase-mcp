BEGIN;

SET LOCAL search_path = ue_mcp, public, pg_catalog;

DO $$
DECLARE
  project_id uuid;
  repository_id uuid;
  user_id uuid;
  generation_id uuid;
BEGIN
  INSERT INTO users (external_subject, display_name)
  VALUES ('integration-subject', 'Integration User')
  RETURNING id INTO user_id;

  BEGIN
    INSERT INTO users (external_subject, display_name)
    VALUES ('integration-subject', 'Duplicate User');
    RAISE EXCEPTION 'duplicate external_subject was accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO projects (slug, name, ue_version, created_by, updated_by)
    VALUES ('invalid-version', 'Invalid Version', '5.5', 'integration', 'integration');
    RAISE EXCEPTION 'non-UE-5.6 project was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO projects (slug, name, ue_version, created_by, updated_by)
  VALUES ('migration-test', 'Migration Test', '5.6', 'integration', 'integration')
  RETURNING id INTO project_id;

  IF EXISTS (SELECT 1 FROM users WHERE id = user_id AND svn_subject IS NOT NULL) THEN
    RAISE EXCEPTION 'migration invented an SVN subject for a legacy user';
  END IF;

  INSERT INTO repositories (
    project_id, canonical_url, role, credential_ref, created_by, updated_by
  ) VALUES (
    project_id, 'https://svn.example.invalid/project', 'game', 'secret://test/svn', 'integration', 'integration'
  ) RETURNING id INTO repository_id;

  BEGIN
    INSERT INTO svn_access_snapshots (
      repository_id, revision, subject, effective_access, captured_at, expires_at, path_prefix
    ) VALUES (
      repository_id, 1, 'integration-subject', 'read', clock_timestamp(),
      clock_timestamp() + interval '5 minutes', '../private'
    );
    RAISE EXCEPTION 'unsafe SVN path prefix was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO service_principals (id, svn_subject, created_by, updated_by)
    VALUES ('invalid/service', 'service-subject', 'integration', 'integration');
    RAISE EXCEPTION 'unsafe service principal identifier was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO index_generations (
    project_id,
    revision_set_hash,
    status,
    started_at
  ) VALUES (
    project_id,
    decode(repeat('11', 32), 'hex'),
    'building',
    clock_timestamp()
  ) RETURNING id INTO generation_id;

  BEGIN
    UPDATE index_generations
    SET symbol_plan_hash = decode(repeat('33', 32), 'hex')
    WHERE id = generation_id;
    RAISE EXCEPTION 'partial symbol import state was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET relation_plan_hash = decode(repeat('44', 32), 'hex')
    WHERE id = generation_id;
    RAISE EXCEPTION 'partial relation import state was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET chunk_plan_hash = decode(repeat('66', 32), 'hex')
    WHERE id = generation_id;
    RAISE EXCEPTION 'partial chunk import state was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET relation_plan_hash = decode(repeat('44', 32), 'hex'),
        relation_payload_hash = decode(repeat('55', 32), 'hex'),
        symbol_edge_count = 0,
        file_dependency_count = 0,
        relations_imported_at = clock_timestamp()
    WHERE id = generation_id;
    RAISE EXCEPTION 'relation import without symbols was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET chunk_plan_hash = decode(repeat('66', 32), 'hex'),
        chunk_payload_hash = decode(repeat('77', 32), 'hex'),
        code_chunk_count = 0,
        chunks_imported_at = clock_timestamp()
    WHERE id = generation_id;
    RAISE EXCEPTION 'chunk import without symbols was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO index_generations (
      project_id,
      revision_set_hash,
      status,
      started_at
    ) VALUES (
      project_id,
      decode(repeat('22', 32), 'hex'),
      'active',
      clock_timestamp()
    );
    RAISE EXCEPTION 'active generation without publication evidence was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET status = 'ready', manifest_uri = 'https://artifacts.example/invalid.json'
    WHERE id = generation_id;
    RAISE EXCEPTION 'ready generation without validated publication evidence was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE index_generations
    SET manifest_hash = decode(repeat('88', 32), 'hex')
    WHERE id = generation_id;
    RAISE EXCEPTION 'partial generation validation evidence was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jobs (
      project_id,
      type,
      requester_type,
      requester_id,
      revision_set,
      status,
      started_at
    ) VALUES (
      project_id,
      'reindex',
      'user',
      user_id::text,
      '{}'::jsonb,
      'running',
      clock_timestamp()
    );
    RAISE EXCEPTION 'running job without a lease was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jobs (
      project_id, type, requester_type, requester_id, revision_set, status, lease_token
    ) VALUES (
      project_id, 'reindex', 'user', user_id::text, '{}'::jsonb, 'queued', gen_random_uuid()
    );
    RAISE EXCEPTION 'queued job with a lease token was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO jobs (
      project_id, type, requester_type, requester_id, revision_set, status, finished_at
    ) VALUES (
      project_id, 'reindex', 'user', user_id::text, '{}'::jsonb, 'succeeded', clock_timestamp()
    );
    RAISE EXCEPTION 'succeeded job without a completion manifest was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  UPDATE projects SET name = 'Migration Test Updated' WHERE id = project_id;
  IF NOT EXISTS (
    SELECT 1 FROM projects
    WHERE id = project_id AND updated_at >= created_at
  ) THEN
    RAISE EXCEPTION 'updated_at trigger did not maintain timestamp ordering';
  END IF;
END;
$$;

ROLLBACK;
