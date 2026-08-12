'use strict';

const NCI = 'https://www.cancer.gov/publications/dictionaries/cancer-terms/def/';
const MW = 'https://www.merriam-webster.com/dictionary/';

function dentalTerm(canonical_term, category, pronunciation_value, options = {}) {
  return Object.freeze({
    canonical_term,
    normalized_term: canonical_term.toLocaleLowerCase('en-US'),
    pronunciation_method: options.method || 'alias',
    pronunciation_value,
    scope_type: 'industry',
    industry_key: 'dental',
    client_id: null,
    source: 'industry_seed',
    verification_status: options.verified ? 'verified' : 'suggested',
    is_active: true,
    version: 1,
    category,
    evidence_url: options.evidenceUrl || null,
    confidence: options.confidence || (options.verified ? 'high' : 'unverified'),
    case_sensitive: Boolean(options.caseSensitive),
    word_boundaries: options.wordBoundaries !== false,
    discovery_requires_approved_terminology: Boolean(options.discoveryRequiresApprovedTerminology),
  });
}

const DENTAL_PRONUNCIATION_SEED = Object.freeze([
  dentalTerm('endodontics', 'specialties', 'en-doh-DON-tiks', { verified: true, evidenceUrl: `${MW}endodontics` }),
  dentalTerm('periodontics', 'specialties', 'pair-ee-oh-DON-tiks', { verified: true, evidenceUrl: `${MW}periodontics` }),
  dentalTerm('prosthodontics', 'specialties', 'pros-thoh-DON-tiks', { verified: true, evidenceUrl: `${MW}prosthodontics` }),
  dentalTerm('orthodontics', 'specialties', 'or-thoh-DON-tiks', { verified: true, evidenceUrl: `${MW}orthodontics` }),
  dentalTerm('oral and maxillofacial surgery', 'specialties', 'oral and maxillofacial surgery'),
  dentalTerm('pediatric dentistry', 'specialties', 'pediatric dentistry'),
  dentalTerm('xerostomia', 'clinical_anatomy', 'ZEER-oh-STOH-mee-uh', { verified: true, evidenceUrl: `${NCI}xerostomia` }),
  dentalTerm('occlusion', 'clinical_anatomy', 'occlusion'),
  dentalTerm('malocclusion', 'clinical_anatomy', 'malocclusion'),
  dentalTerm('gingiva', 'clinical_anatomy', 'JIN-jih-vuh', { verified: true, evidenceUrl: `${NCI}gingiva` }),
  dentalTerm('periodontal', 'clinical_anatomy', 'pair-ee-oh-DON-tul', { verified: true, evidenceUrl: `${MW}periodontal` }),
  dentalTerm('periapical', 'clinical_anatomy', 'periapical'),
  dentalTerm('interproximal', 'clinical_anatomy', 'interproximal'),
  dentalTerm('edentulous', 'clinical_anatomy', 'edentulous'),
  dentalTerm('CBCT', 'imaging_technology', 'C B C T', { verified: true, confidence: 'curated', evidenceUrl: 'https://www.ada.org/resources/research/science-and-research-institute/oral-health-topics/cone-beam-computed-tomography', caseSensitive: true }),
  dentalTerm('cephalometric', 'imaging_technology', 'cephalometric'),
  dentalTerm('CAD/CAM', 'imaging_technology', 'cad cam', { caseSensitive: true }),
  dentalTerm('intraoral scanner', 'imaging_technology', 'intraoral scanner'),
  dentalTerm('panoramic', 'imaging_technology', 'panoramic'),
  dentalTerm('bitewing', 'imaging_technology', 'bitewing'),
  dentalTerm('prophylaxis', 'procedures_materials', 'PROH-fih-LAK-sis', { verified: true, evidenceUrl: `${NCI}prophylaxis` }),
  dentalTerm('scaling and root planing', 'procedures_materials', 'scaling and root planing'),
  dentalTerm('pulpotomy', 'procedures_materials', 'pulpotomy'),
  dentalTerm('pulpectomy', 'procedures_materials', 'pulpectomy'),
  dentalTerm('endodontic therapy', 'procedures_materials', 'endodontic therapy'),
  dentalTerm('composite', 'procedures_materials', 'composite'),
  dentalTerm('amalgam', 'procedures_materials', 'amalgam'),
  dentalTerm('zirconia', 'procedures_materials', 'zirconia'),
  dentalTerm('porcelain-fused-to-metal', 'procedures_materials', 'porcelain fused to metal'),
  dentalTerm('Invisalign', 'orthodontic_specialty', 'invisalign'),
  dentalTerm('aligners', 'orthodontic_specialty', 'aligners'),
  dentalTerm('cephalometric tracing', 'orthodontic_specialty', 'cephalometric tracing'),
  dentalTerm('Open Dental', 'dental_software_operations', 'Open Dental'),
  dentalTerm('Dentrix', 'dental_software_operations', 'Dentrix'),
  dentalTerm('Eaglesoft', 'dental_software_operations', 'Eaglesoft'),
  dentalTerm('Curve', 'dental_software_operations', 'Curve', { caseSensitive: true, discoveryRequiresApprovedTerminology: true }),
]);

module.exports = { DENTAL_PRONUNCIATION_SEED };
