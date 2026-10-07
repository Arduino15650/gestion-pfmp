import {useEffect,useRef,useState} from 'react';
import {Trash2} from 'lucide-react';
import {type Row} from './helpers';
export default function StudentDeleteDialog({students,busy,onClose,onDelete}:{students:Row[];busy:boolean;onClose:()=>void;onDelete:(students:Row[],confirmation:string)=>Promise<boolean>}){
 const dialog=useRef<HTMLDialogElement>(null),[confirmation,setConfirmation]=useState(''),[error,setError]=useState('');
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>{dialog.current?.close();previous?.focus();};},[]);
 return <dialog ref={dialog} className="student-delete-dialog" aria-labelledby="student-delete-title" onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <form onSubmit={async e=>{e.preventDefault();if(busy||confirmation.trim()!=='SUPPRIMER')return;setError('');if(await onDelete(students,confirmation.trim()))onClose();else setError('La suppression n’a pas pu être confirmée. Fermez cette fenêtre et actualisez la liste avant de réessayer.');}}>
   <h2 id="student-delete-title">Supprimer définitivement {students.length===1?'cet élève':`ces ${students.length} élèves`} ?</h2>
   <p>Leurs fiches, comptes de connexion, codes d’accès et comptes rendus seront supprimés. Leurs entreprises seront conservées et leurs réservations PFMP libérées.</p>
   <ul className="student-delete-list">{students.map(s=><li key={s.id}><strong>{s.name}</strong><span>{s.class_name}</span></li>)}</ul>
   <p className="notice warning">Cette action est définitive. Aucun retour en arrière n’est possible depuis le site.</p>
   <label htmlFor="student-delete-confirm">Pour confirmer, saisissez <strong>SUPPRIMER</strong></label>
   <input id="student-delete-confirm" autoFocus autoComplete="off" spellCheck={false} disabled={busy} value={confirmation} onChange={e=>setConfirmation(e.target.value)}/>
   {error&&<p role="alert" className="auth-error">{error}</p>}
   <div className="modal-actions"><button type="button" className="pill" disabled={busy} onClick={onClose}>Annuler</button><button type="submit" className="pill danger" disabled={busy||confirmation.trim()!=='SUPPRIMER'}><Trash2 size={15}/>{busy?'Suppression…':'Supprimer définitivement'}</button></div>
  </form>
 </dialog>;
}
