-- reviews.interaction_id: on delete cascade -> restrict
-- 관측 데이터는 하나도 지우지 않는다. interactions 행 삭제가 reviews 까지 번지지 않게 하고,
-- reviews 가 붙은 interactions 행은 삭제 자체가 막히게 한다.
alter table public.reviews
  drop constraint reviews_interaction_id_fkey,
  add constraint reviews_interaction_id_fkey
    foreign key (interaction_id) references public.interactions(id) on delete restrict;
