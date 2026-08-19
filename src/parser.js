'use strict';

/**
 * Turns a c2patool manifest store report into a small view model the UI can
 * render directly. Exposed as window.Parser.
 */
(function () {
  // IPTC digitalsourcetype codes that indicate AI involvement.
  const AI_SOURCE_TYPES =
    /trainedAlgorithmicMedia|algorithmicMedia|compositeWithTrainedAlgorithmicMedia|compositeSynthetic/i;

  const SOURCE_LABELS = {
    trainedAlgorithmicMedia: 'AI-generated (trained algorithmic media)',
    compositeWithTrainedAlgorithmicMedia: 'AI + capture (composite)',
    compositeSynthetic: 'Composite synthetic',
    algorithmicMedia: 'Algorithmic media',
    digitalCapture: 'Digital capture (camera)',
    computationalCapture: 'Computational capture',
    digitalCreation: 'Digital creation',
    digitalArt: 'Digital art',
    minorHumanEdits: 'Minor human edits',
  };

  function prettify(s) {
    return String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase());
  }

  function sourceLabel(uri) {
    if (!uri) return null;
    const key = String(uri).split('/').pop();
    return SOURCE_LABELS[key] || prettify(key);
  }

  /** Collect { name, version } from claim_generator_info / claim_generator. */
  function generatorsOf(m) {
    const out = [];
    const infos = Array.isArray(m.claim_generator_info) ? m.claim_generator_info : [];
    for (const info of infos) {
      if (!info) continue;
      const name = info.name || 'Unknown';
      let version = info.version || null;
      if (!version) {
        for (const [k, v] of Object.entries(info)) {
          if (k !== 'name' && typeof v === 'string' && /c2pa|version|_rs$/i.test(k)) {
            version = v;
            break;
          }
        }
      }
      out.push({ name, version });
    }

    if (!out.length && typeof m.claim_generator === 'string') {
      const seen = new Set();
      for (const part of m.claim_generator.split(/\s+/)) {
        if (!part) continue;
        const [name, version] = part.split('/');
        const key = `${name}@${version}`;
        if (name && !seen.has(key)) {
          seen.add(key);
          out.push({ name, version: version || null });
        }
      }
    }
    return out;
  }

  function actionsOf(m) {
    const assertions = Array.isArray(m.assertions) ? m.assertions : [];
    const aa = assertions.find((a) => a && /^c2pa\.actions/.test(a.label || ''));
    return aa && aa.data && Array.isArray(aa.data.actions) ? aa.data.actions : [];
  }

  function softwareAgentName(agent) {
    if (!agent) return null;
    return typeof agent === 'string' ? agent : agent.name || null;
  }

  function parseManifest(id, m, isActive) {
    const actions = actionsOf(m);

    let aiGenerated = false;
    let digitalSourceType = null;
    let softwareAgent = null;
    let model = null;

    for (const act of actions) {
      const params = act.parameters || {};
      const dst = act.digitalSourceType || params['com.adobe.digitalSourceType'] || null;
      if (dst) {
        if (!digitalSourceType) digitalSourceType = dst;
        if (AI_SOURCE_TYPES.test(dst)) aiGenerated = true;
      }
      if (!softwareAgent) softwareAgent = softwareAgentName(act.softwareAgent);
      if (
        !model &&
        (params['com.adobe.modelVersion'] || params['com.adobe.modelId'] || params['com.adobe.details'])
      ) {
        model = {
          version: params['com.adobe.modelVersion'] || null,
          id: params['com.adobe.modelId'] || null,
          details: params['com.adobe.details'] || null,
          type: params['com.adobe.type'] || null,
          genAiId: params['com.adobe.genAiId'] || null,
        };
      }
    }

    const si = m.signature_info || null;
    const signature = si
      ? {
          issuer: si.issuer || null,
          commonName: si.common_name || null,
          alg: si.alg || null,
          time: si.time || null,
          certSerial: si.cert_serial_number || null,
        }
      : null;

    const ingredients = (Array.isArray(m.ingredients) ? m.ingredients : []).map((ing) => {
      const vr = ing.validation_results && ing.validation_results.activeManifest;
      return {
        title: ing.title || ing.format || 'ingredient',
        format: ing.format || null,
        relationship: ing.relationship || null,
        activeManifest:
          ing.active_manifest || (ing.manifest_data && ing.manifest_data.identifier) || null,
        success: vr ? (vr.success || []).length : null,
        failure: vr ? (vr.failure || []).length : null,
      };
    });

    return {
      id,
      isActive,
      title: m.title || null,
      format: m.format || null,
      claimVersion: m.claim_version != null ? m.claim_version : null,
      generators: generatorsOf(m),
      actions: actions.map((a) => ({
        action: a.action || null,
        when: a.when || null,
        softwareAgent: softwareAgentName(a.softwareAgent),
      })),
      aiGenerated,
      digitalSourceType,
      digitalSourceLabel: sourceLabel(digitalSourceType),
      softwareAgent,
      model,
      signature,
      ingredients,
    };
  }

  function parse(store) {
    if (!store || typeof store !== 'object') return null;

    const manifestsObj = store.manifests || {};
    const activeId = store.active_manifest || null;
    const byId = {};
    const manifests = [];
    for (const [id, m] of Object.entries(manifestsObj)) {
      const vm = parseManifest(id, m, id === activeId);
      byId[id] = vm;
      manifests.push(vm);
    }

    const state = store.validation_state || 'Unknown';
    const vr = (store.validation_results && store.validation_results.activeManifest) || {};
    const mapEntry = (f) => ({ code: f.code || '', explanation: f.explanation || '' });
    const failures = (vr.failure || store.validation_status || []).map(mapEntry);
    const informational = (vr.informational || []).map(mapEntry);
    const success = (vr.success || []).map(mapEntry);
    const successes = success.length;
    // The trust checks are the only successes worth spelling out: their
    // explanation names which anchor list the signer or the timestamp matched
    // (e.g. "signing certificate trusted, found in System trust anchors").
    // The rest of the successes stay behind the "Checks passed" count.
    const trusted = success.filter((e) => e.code.endsWith('.trusted'));

    let badge = 'warn';
    // c2pa-rs reports Valid | Invalid | Trusted (Trusted = valid + a trusted signer).
    if (state === 'Valid' || state === 'Trusted') badge = 'ok';
    else if (state === 'Invalid') badge = 'bad';
    else if (state === 'Unknown') badge = 'none';

    // Distinct C2PA claim versions present anywhere in the store. A store can
    // mix versions (e.g. a v2 asset built on v1 ingredients), so we surface
    // every version found, not just the active manifest's.
    const claimVersions = [];
    for (const vm of manifests) {
      if (vm.claimVersion != null && !claimVersions.includes(vm.claimVersion)) {
        claimVersions.push(vm.claimVersion);
      }
    }
    claimVersions.sort((a, b) => Number(a) - Number(b));

    return {
      validationState: state,
      validationBadge: badge,
      failures,
      informational,
      trusted,
      successes,
      claimVersions,
      activeId,
      active: activeId ? byId[activeId] : manifests[0] || null,
      manifests,
      byId,
    };
  }

  window.Parser = { parse, sourceLabel, prettify };
})();
