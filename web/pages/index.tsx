import { Navigate } from "react-router-dom"

/** 根路径 → 默认总览。 */
export default function IndexPage() {
  return <Navigate to="/overview" replace />
}
