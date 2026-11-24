"""Acceso mínimo a Supabase (REST + Storage) con la clave secreta del servidor.

La clave secreta (sb_secret_... o service_role) va SOLO en el archivo .env de la
computadora del taller. Nunca en la página web ni en el repositorio.
"""
from __future__ import annotations

import json
import os

import requests


class Supabase:
    def __init__(self, url: str, clave: str, bucket_expedientes: str = "expedientes", bucket_disenos: str = "disenos"):
        if not url or not clave:
            raise RuntimeError("Faltan SUPABASE_URL o SUPABASE_SECRET_KEY en el archivo .env")
        self.url = url.rstrip("/")
        self.clave = clave
        self.be = bucket_expedientes
        self.bd = bucket_disenos
        self.s = requests.Session()
        h = {"apikey": clave}
        if clave.startswith("eyJ"):
            h["Authorization"] = f"Bearer {clave}"
        self.s.headers.update(h)

    # ---- tablas ----
    def pedidos_pendientes(self, limite: int = 5) -> list[dict]:
        r = self.s.get(f"{self.url}/rest/v1/pedidos", params={
            "select": "id,folio,creado,estado,producto,gratis,datos,archivos",
            "estado": "eq.nuevo", "order": "creado.asc", "limit": str(limite)}, timeout=30)
        r.raise_for_status()
        return r.json()

    def pedido(self, id_o_folio: str) -> dict | None:
        campo = "folio" if id_o_folio.upper().startswith("OS-") else "id"
        r = self.s.get(f"{self.url}/rest/v1/pedidos", params={
            "select": "id,folio,creado,estado,producto,gratis,datos,archivos", campo: f"eq.{id_o_folio}"}, timeout=30)
        r.raise_for_status()
        filas = r.json()
        return filas[0] if filas else None

    def marcar_pedido(self, pedido_id: str, estado: str) -> None:
        r = self.s.patch(f"{self.url}/rest/v1/pedidos", params={"id": f"eq.{pedido_id}"},
                         json={"estado": estado}, headers={"Prefer": "return=minimal"}, timeout=30)
        r.raise_for_status()

    def ultimo_diseno(self, pedido_id: str) -> dict | None:
        r = self.s.get(f"{self.url}/rest/v1/disenos", params={
            "select": "version,estado", "pedido": f"eq.{pedido_id}", "order": "version.desc", "limit": "1"}, timeout=30)
        r.raise_for_status()
        filas = r.json()
        return filas[0] if filas else None

    def guardar_diseno(self, fila: dict) -> None:
        r = self.s.post(f"{self.url}/rest/v1/disenos", params={"on_conflict": "pedido,version"},
                        data=json.dumps(fila), headers={"Content-Type": "application/json",
                                                        "Prefer": "resolution=merge-duplicates,return=minimal"}, timeout=30)
        r.raise_for_status()

    # ---- storage ----
    def descargar(self, ruta: str, destino: str) -> str:
        os.makedirs(os.path.dirname(destino), exist_ok=True)
        with self.s.get(f"{self.url}/storage/v1/object/authenticated/{self.be}/{ruta}", stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(destino + ".part", "wb") as f:
                for trozo in r.iter_content(1 << 20):
                    f.write(trozo)
        os.replace(destino + ".part", destino)
        return destino

    def subir(self, ruta: str, contenido: bytes, tipo: str) -> str:
        r = self.s.post(f"{self.url}/storage/v1/object/{self.bd}/{ruta}", data=contenido,
                        headers={"Content-Type": tipo, "x-upsert": "true"}, timeout=120)
        r.raise_for_status()
        return ruta
