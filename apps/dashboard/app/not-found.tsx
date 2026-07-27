import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Brand, SluiceMascot } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="login-panel">
      <div className="empty-state-inner" style={{ textAlign: "center" }}>
        <Brand showTag={false} />
        <div style={{ marginTop: 40 }}>
          <SluiceMascot state="alert" size={105} />
        </div>
        <h1 className="display" style={{ margin: "20px 0 8px" }}>
          Caminho não encontrado
        </h1>
        <p className="text-muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
          O Sluice não encontrou essa área do console.
        </p>
        <Link className="button button-primary" href="/" style={{ marginTop: 18 }}>
          <ArrowLeft size={15} /> Voltar à visão geral
        </Link>
      </div>
    </main>
  );
}
