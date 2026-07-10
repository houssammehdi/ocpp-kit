/** PEM material: one item or several (e.g. a certificate chain or several CAs). */
export type PemInput = string | Buffer | readonly (string | Buffer)[];
