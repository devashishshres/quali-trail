/**
 * Fictional demo dataset for InstallerOS. ALL PEOPLE, EMPLOYERS,
 * ISSUERS AND NUMBERS HERE ARE INVENTED. Every row is is_synthetic = true.
 *
 * Expected first match run (before the demo upload):
 *   R1 EPA 608            -> evidence_found         (E3, document supplied)
 *   R2 Manufacturer training -> evidence_found      (E1, document supplied)
 *   R3 Install/startup    -> needs_review           (E2 is self-reported only)
 *   R4 Commissioning list -> no_sufficient_evidence (no checklist; E2 + E4 supporting)
 * After the demo commissioning checklist is uploaded and indexed:
 *   R4 -> evidence_found. R3 stays needs_review.
 */
import type {
  EvidenceSourceKind,
  EvidenceType,
  RequirementCriteria,
  StructuredEvidenceData,
  VerificationStatus,
} from "../../lib/types";

export const DEMO_USER_EMAIL = "alex.morgan@demo.installeros.dev";

export const DEMO_WORKER = {
  id: "a0000000-0000-4000-8000-000000000001",
  name: "Alex Morgan",
  trade: "HVAC / Heat-Pump Installation",
} as const;

export interface DemoEvidence {
  id: string;
  type: EvidenceType;
  title: string;
  date: string;
  issuer: string | null;
  sourceKind: EvidenceSourceKind;
  verificationStatus: VerificationStatus;
  structuredData: StructuredEvidenceData;
  /** File name under supabase/seed/files/, if this record has an original document. */
  fileName: string | null;
}

export const DEMO_EVIDENCE: readonly DemoEvidence[] = [
  {
    id: "e0000000-0000-4000-8000-000000000001",
    type: "training",
    title: "Heat-Pump Installation & Startup Training — Certificate of Completion",
    date: "2025-03-14",
    issuer: "Northwind Climate Systems Training Center (fictional manufacturer)",
    sourceKind: "seed",
    verificationStatus: "document_supplied",
    fileName: "e1-manufacturer-training.pdf",
    structuredData: {
      skills: ["Heat-pump installation", "Refrigerant line-set brazing", "Manufacturer startup procedure"],
      activities: ["Completed 16-hour manufacturer installation course"],
      equipment: ["Northwind NX-series air-source heat pump (fictional)"],
      expirationDate: null,
      credentialNumber: "NW-TRN-2025-0314-DEMO",
      summary:
        "Manufacturer training covering heat-pump installation, line-set brazing and the factory startup procedure.",
    },
  },
  {
    id: "e0000000-0000-4000-8000-000000000002",
    type: "work_record",
    title: "Heat-pump startup and operational test — residential job",
    date: "2025-09-17",
    issuer: "Desert Air Mechanical (fictional employer)",
    sourceKind: "seed",
    verificationStatus: "self_reported",
    fileName: null,
    structuredData: {
      skills: ["Heat-pump startup", "Operational testing"],
      activities: [
        "Performed startup on a 3-ton ducted heat pump",
        "Verified heating and cooling mode operation",
        "Recorded suction and discharge pressures",
        "Checked defrost cycle",
      ],
      equipment: ["3-ton ducted air-source heat pump"],
      expirationDate: null,
      credentialNumber: null,
      summary: "Worker-entered description of a residential heat-pump startup and operational test.",
    },
  },
  {
    id: "e0000000-0000-4000-8000-000000000003",
    type: "certification",
    title: "EPA Section 608 Technician Certification — Universal",
    date: "2026-06-05",
    issuer: "Sample Certifying Organization (fictional, demo only)",
    sourceKind: "seed",
    verificationStatus: "document_supplied",
    fileName: "e3-epa-608-card.pdf",
    structuredData: {
      skills: ["Refrigerant handling", "Refrigerant recovery"],
      activities: [],
      equipment: [],
      // EPA Section 608 certifications do not expire. Never set a generic expiry.
      expirationDate: null,
      credentialNumber: "DEMO-608-000123",
      summary: "Universal EPA Section 608 technician certification card (fictional sample).",
    },
  },
  {
    id: "e0000000-0000-4000-8000-000000000004",
    type: "work_record",
    title: "Airflow measurement and blower adjustment record",
    date: "2026-06-22",
    issuer: "Desert Air Mechanical (fictional employer)",
    sourceKind: "seed",
    verificationStatus: "self_reported",
    fileName: null,
    structuredData: {
      skills: ["Airflow measurement", "Static pressure testing"],
      activities: [
        "Measured total external static pressure",
        "Measured supply airflow (CFM) at registers",
        "Adjusted blower speed tap to reach target CFM per ton",
      ],
      equipment: ["Manometer", "Flow hood", "Ducted heat-pump air handler"],
      expirationDate: null,
      credentialNumber: null,
      summary: "Worker-entered record of airflow checks and blower adjustment on a heat-pump system.",
    },
  },
];

export const DEMO_OPPORTUNITY = {
  id: "b0000000-0000-4000-8000-000000000001",
  title: "Heat-Pump Installation Technician",
  employer: "Demo HVAC Company (fictional)",
  description:
    "Fictional job posting for the InstallerOS demo. Install, start up and commission residential air-source heat pumps.",
  sourceUrl: null,
} as const;

export interface DemoRequirement {
  id: string;
  position: number;
  originalText: string;
  mandatory: boolean;
  criteria: RequirementCriteria;
}

const REQUIREMENT_SOURCE = "Demo job posting (fictional)";
export { REQUIREMENT_SOURCE };

export const DEMO_REQUIREMENTS: readonly DemoRequirement[] = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    position: 0,
    originalText: "Must hold an EPA Section 608 certification (Type II or Universal).",
    mandatory: true,
    criteria: {
      acceptedTypes: ["certification"],
      supportingTypes: [],
      keywords: ["EPA", "608"],
      retrievalQuery: "EPA Section 608 refrigerant handling technician certification",
      requiredFields: ["issuer"],
    },
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    position: 1,
    originalText: "Completion of manufacturer heat-pump installation training.",
    mandatory: true,
    criteria: {
      acceptedTypes: ["training"],
      supportingTypes: [],
      keywords: ["heat-pump", "heat pump", "manufacturer"],
      retrievalQuery: "manufacturer heat pump installation training course certificate",
      requiredFields: ["issuer", "date"],
    },
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    position: 2,
    originalText: "Documented hands-on experience installing and starting up residential heat-pump systems.",
    mandatory: true,
    criteria: {
      acceptedTypes: ["work_record", "checklist"],
      supportingTypes: ["training"],
      keywords: ["startup", "start-up", "install", "operational test"],
      retrievalQuery: "hands-on heat pump installation and startup work experience",
      requiredFields: ["date"],
    },
  },
  {
    id: "c0000000-0000-4000-8000-000000000004",
    position: 3,
    originalText: "A completed commissioning checklist for at least one heat-pump installation.",
    mandatory: true,
    criteria: {
      acceptedTypes: ["checklist"],
      supportingTypes: ["work_record", "training"],
      keywords: ["commissioning", "checklist"],
      retrievalQuery: "heat pump commissioning checklist refrigerant charge airflow verification",
      requiredFields: ["date"],
    },
  },
];
