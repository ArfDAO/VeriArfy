/**
 * E/18 sentetik genomik + BMI fixture'i ve bagimsiz plaintext referansi.
 *
 * Bu dosya gercek kisi verisi icermez: satirlar kimliksiz, deterministik test
 * degerleridir. Amaci, FHE hattinin 2x3 SNP sayimlarini ve BMI yeterli
 * istatistiklerini ayni ham girdiden eksiksiz urettigini kanitlamaktir.
 */

export const E18_SYNTHETIC_FIXTURE_ID = "e18-synthetic-bmi-snp-v1";
export const E18_SYNTHETIC_GROUP_SIZE = 30;
export const E18_SYNTHETIC_PARTICIPANTS = E18_SYNTHETIC_GROUP_SIZE * 2;

/** Her grup 30 kisidir; 2x3 hucrelerin her biri en az 5 kisi icerir. */
function dosageFor(group, index) {
  if (group === 0) return index < 15 ? 0 : index < 25 ? 1 : 2;
  return index < 5 ? 0 : index < 15 ? 1 : 2;
}

/** 30 simetrik offsetin toplami sifirdir; grup ortalamalari tam tanimlidir. */
function bmiFor(group, index) {
  const offset = -145 + index * 10;
  return (group === 0 ? 2400 : 3000) + offset;
}

/**
 * Kimliksiz, sirasi sabit E/18 fixture'ini yeni nesneler halinde uretir.
 * @returns {{ group: 0 | 1, dosage: 0 | 1 | 2, bmi: number }[]}
 */
export function makeE18SyntheticCohort() {
  const rows = [];
  for (const group of [0, 1]) {
    for (let index = 0; index < E18_SYNTHETIC_GROUP_SIZE; index++) {
      rows.push({ group, dosage: dosageFor(group, index), bmi: bmiFor(group, index) });
    }
  }
  return rows;
}

function emptyAggregate() {
  return { n: 0, sum: 0, sumSq: 0 };
}

/**
 * FHE kodunu cagirmadan ham sentetik satirlardan E/18 ciktilarini hesaplar.
 * Referans, zincirdeki aggregate handle'lar veya production istatistik
 * fonksiyonlariyla ortak durum tasimaz; yalnizca duz diziler uzerinden sayar.
 */
export function e18PlaintextReference(rows) {
  const contingency = [[0, 0, 0], [0, 0, 0]];
  const bmi = [emptyAggregate(), emptyAggregate()];

  for (const row of rows) {
    if (!row || (row.group !== 0 && row.group !== 1)) {
      throw new TypeError("E/18 fixture group 0 veya 1 olmalidir");
    }
    if (!Number.isInteger(row.dosage) || row.dosage < 0 || row.dosage > 2) {
      throw new TypeError("E/18 fixture dosage 0, 1 veya 2 olmalidir");
    }
    if (!Number.isInteger(row.bmi) || row.bmi < 1000 || row.bmi > 8000) {
      throw new TypeError("E/18 fixture BMI 1000..8000 olcekli tamsayi olmalidir");
    }

    contingency[row.group][row.dosage] += 1;
    const aggregate = bmi[row.group];
    aggregate.n += 1;
    aggregate.sum += row.bmi;
    aggregate.sumSq += row.bmi * row.bmi;
  }

  return { participantCount: rows.length, contingency, bmi };
}
