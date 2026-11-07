/**
 * Document-protection UI strings (Review → Protection). Every locale spreads the
 * English base and overrides it (same pattern as the certificate-sign strings).
 */
const protectStrings = {
  protect: 'Protect',
  protectHint: 'Set, change or remove the password this file is saved with',
  protectTitle: 'Document protection',
  protectSetHint:
    'The next save writes this file with a password. Readers need it to open the document.',
  protectChangeHint: 'The next save re-writes the file with this password and these limits.',
  protectPasswordLabel: 'Password to open',
  protectConfirmLabel: 'Confirm password',
  protectOwnerLabel: 'Owner password (optional)',
  protectPermsLabel: 'Once opened, readers may:',
  permPrint: 'Print',
  permModify: 'Edit content',
  permAnnotate: 'Annotate and fill forms',
  permCopy: 'Copy text and images',
  protectApply: 'Apply protection',
  protectRemove: 'Remove protection',
  protectMismatch: 'The passwords do not match',
}

const localizedProtectStrings: Record<string, Partial<typeof protectStrings>> = {

  fr: {
    protect: 'Protéger',
    protectHint: "Définir, modifier ou retirer le mot de passe d'enregistrement de ce fichier",
    protectTitle: 'Protection du document',
    protectSetHint:
      "Le prochain enregistrement écrira ce fichier avec un mot de passe ; les lecteurs devront le saisir pour l'ouvrir.",
    protectChangeHint:
      'Le prochain enregistrement réécrira le fichier avec ce mot de passe et ces limites.',
    protectPasswordLabel: "Mot de passe d'ouverture",
    protectConfirmLabel: 'Confirmer le mot de passe',
    protectOwnerLabel: 'Mot de passe propriétaire (facultatif)',
    protectPermsLabel: 'Une fois ouvert, le lecteur peut :',
    permPrint: 'Imprimer',
    permModify: 'Modifier le contenu',
    permAnnotate: 'Annoter et remplir les formulaires',
    permCopy: 'Copier le texte et les images',
    protectApply: 'Appliquer la protection',
    protectRemove: 'Retirer la protection',
    protectMismatch: 'Les mots de passe ne correspondent pas',
  },

  ar: {
    protect: 'حماية',
    protectHint: 'تعيين كلمة مرور الحفظ لهذا الملف أو تغييرها أو إزالتها',
    protectTitle: 'حماية المستند',
    protectSetHint: 'سيُكتب الحفظ التالي للملف بكلمة مرور؛ يحتاجها القراء لفتح المستند.',
    protectChangeHint: 'سيعيد الحفظ التالي كتابة الملف بهذه كلمة المرور وهذه القيود.',
    protectPasswordLabel: 'كلمة مرور الفتح',
    protectConfirmLabel: 'تأكيد كلمة المرور',
    protectOwnerLabel: 'كلمة مرور المالك (اختياري)',
    protectPermsLabel: 'بعد الفتح، يمكن للقارئ:',
    permPrint: 'الطباعة',
    permModify: 'تعديل المحتوى',
    permAnnotate: 'التعليق وتعبئة النماذج',
    permCopy: 'نسخ النصوص والصور',
    protectApply: 'تطبيق الحماية',
    protectRemove: 'إزالة الحماية',
    protectMismatch: 'كلمتا المرور غير متطابقتين',
  },
}

export const protectStringsFor = (lang: string) => ({
  ...protectStrings,
  ...(localizedProtectStrings[lang as keyof typeof localizedProtectStrings] ?? {}),
})
