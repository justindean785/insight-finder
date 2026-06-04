import {
  User, Building2, Globe, Network, Server, Cable,
  Mail, Phone, Wallet, FolderArchive, FileText, Image,
  MapPin, Boxes, ShieldAlert, AtSign,
  type LucideIcon,
} from "lucide-react";

export type EntityType =
  | "person"
  | "organization"
  | "domain"
  | "subdomain"
  | "ip"
  | "asn"
  | "email"
  | "phone"
  | "wallet"
  | "case"
  | "document"
  | "image"
  | "geo"
  | "infrastructure"
  | "breach"
  | "social_handle";

/** Curated 16-icon vocabulary. Single source of truth for entity glyphs. */
export const ENTITY_ICONS: Record<EntityType, LucideIcon> = {
  person: User,
  organization: Building2,
  domain: Globe,
  subdomain: Network,
  ip: Server,
  asn: Cable,
  email: Mail,
  phone: Phone,
  wallet: Wallet,
  case: FolderArchive,
  document: FileText,
  image: Image,
  geo: MapPin,
  infrastructure: Boxes,
  breach: ShieldAlert,
  social_handle: AtSign,
};

/** Map free-form artifact `kind` strings to a curated EntityType. */
export function toEntityType(kind: string | null | undefined): EntityType {
  const k = (kind ?? "").toLowerCase().trim();
  if (!k) return "document";
  if (k === "person" || k === "name" || k === "individual") return "person";
  if (k === "org" || k === "organization" || k === "company") return "organization";
  if (k === "domain") return "domain";
  if (k === "subdomain" || k === "host") return "subdomain";
  if (k === "ip" || k === "ipv4" || k === "ipv6") return "ip";
  if (k === "asn") return "asn";
  if (k === "email") return "email";
  if (k === "phone") return "phone";
  if (k === "wallet" || k === "crypto" || k === "address_crypto") return "wallet";
  if (k === "case" || k === "legal_record") return "case";
  if (k === "image" || k === "avatar" || k === "photo") return "image";
  if (k === "geo" || k === "location" || k === "address") return "geo";
  if (k === "breach" || k === "leak") return "breach";
  if (k === "infrastructure" || k === "service" || k === "tech_stack") return "infrastructure";
  if (k === "social" || k === "social_handle" || k === "username" || k === "handle") return "social_handle";
  return "document";
}