BEGIN;

SET LOCAL search_path = ue_mcp, public, pg_catalog;

DO $$
DECLARE
  project_id uuid;
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
